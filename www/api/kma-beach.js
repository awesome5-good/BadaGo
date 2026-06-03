const { TextDecoder } = require('util');

const KMA_RPT_BASE = 'https://www.weather.go.kr/special/CRP/beach/rpt_beach_';
const SURVEY_WATER_TEMP_API =
    'https://apis.data.go.kr/1192136/surveyWaterTemp/GetSurveyWaterTempApiService';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분
const LOG_PREFIX = '[kma-beach]';
const SURVEY_RESPONSE_LOG_MAX = 4000;

/** @type {Map<string, { expiresAt: number, payload: object }>} */
const memoryCache = new Map();

function maskServiceKeyInUrl(url) {
    return String(url).replace(/([?&]serviceKey=)([^&]+)/gi, (_, prefix, key) => {
        const k = decodeURIComponent(key);
        if (k.length <= 8) return `${prefix}****`;
        return `${prefix}${k.slice(0, 4)}...${k.slice(-4)}(len=${k.length})`;
    });
}

/** Vercel 로그: DATA_GO_KR_SERVICE_KEY 로드 여부 (키 값은 마스킹) */
function logDataGoKrKeyStatus(context) {
    const raw = process.env.DATA_GO_KR_SERVICE_KEY;
    const trimmed = raw != null ? String(raw).trim() : '';
    const configured = trimmed.length > 0;
    console.log(`${LOG_PREFIX} DATA_GO_KR_SERVICE_KEY check`, {
        context,
        configured,
        length: configured ? trimmed.length : 0,
        preview: configured ? `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}` : null,
        typeof: raw === undefined ? 'undefined' : typeof raw,
    });
}

function logSurveyResponse(status, text) {
    const body =
        text.length <= SURVEY_RESPONSE_LOG_MAX
            ? text
            : `${text.slice(0, SURVEY_RESPONSE_LOG_MAX)}…(truncated, total ${text.length} chars)`;
    console.log(`${LOG_PREFIX} GetSurveyWaterTempApiService RESPONSE`, {
        httpStatus: status,
        bodyLength: text.length,
        body,
    });
}

function decodeEucKr(buffer) {
    try {
        return new TextDecoder('euc-kr').decode(buffer);
    } catch (_) {
        return buffer.toString('binary');
    }
}

function parseWaterWave(html) {
    const tdMatch = html.match(
        /<td[^>]*align=['"]center['"][^>]*>\s*(\d+(?:\.\d+)?)[^<]*?\/\s*(\d+(?:\.\d+)?)\s*m\s*<\/td>/i
    );
    if (tdMatch) {
        return { water_temp: parseFloat(tdMatch[1]), wave_height: parseFloat(tdMatch[2]) };
    }

    const loose = html.match(/(\d{1,2}(?:\.\d+)?)[^\d<]{0,8}\/\s*(\d+(?:\.\d+)?)\s*m/i);
    if (loose) {
        const water = parseFloat(loose[1]);
        if (water >= 10 && water <= 35) {
            return { water_temp: water, wave_height: parseFloat(loose[2]) };
        }
    }

    return null;
}

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function setCacheHeaders(res, hit) {
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=120');
    if (hit) res.setHeader('X-BadaGo-Cache', 'HIT');
    else res.setHeader('X-BadaGo-Cache', 'MISS');
}

function cacheKey(id, obsCode) {
    return obsCode ? `${id}:${obsCode}` : id;
}

function getMemoryCached(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        memoryCache.delete(key);
        return null;
    }
    return entry.payload;
}

function setMemoryCached(key, payload) {
    memoryCache.set(key, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        payload: { ...payload, cached: true, cached_at: new Date().toISOString() },
    });
}

function parseSurveyItems(json) {
    const items = json?.response?.body?.items?.item;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
}

function pickSurveyWaterTemp(rows) {
    if (!rows.length) return { water_temp: null, obs_time: null };
    const latest = rows[rows.length - 1] || rows[0];
    const temp =
        latest?.water_temp ??
        latest?.waterTemp ??
        latest?.wt ??
        latest?.TEMP ??
        null;
    const obsRaw =
        latest?.obs_time ??
        latest?.obsTime ??
        latest?.record_time ??
        latest?.recordTime ??
        latest?.datetime ??
        null;
    let obs_time = null;
    if (obsRaw != null) {
        const s = String(obsRaw).trim();
        if (/^\d{12}$/.test(s)) {
            obs_time = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
        } else {
            obs_time = s.replace('T', ' ').slice(0, 16);
        }
    }
    return {
        water_temp: temp != null ? parseFloat(temp) : null,
        obs_time,
    };
}

async function fetchSurveyWaterTemp(obsCode) {
    logDataGoKrKeyStatus('fetchSurveyWaterTemp');

    const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
    const trimmedKey = serviceKey != null ? String(serviceKey).trim() : '';
    if (!trimmedKey) {
        console.warn(`${LOG_PREFIX} GetSurveyWaterTempApiService SKIP — DATA_GO_KR_SERVICE_KEY empty`);
        throw new Error('DATA_GO_KR_SERVICE_KEY not configured');
    }

    const q = new URLSearchParams({
        serviceKey: trimmedKey,
        type: 'json',
        obsCode,
        numOfRows: '10',
        pageNo: '1',
        min: '60',
    });
    const url = `${SURVEY_WATER_TEMP_API}?${q.toString()}`;
    console.log(`${LOG_PREFIX} GetSurveyWaterTempApiService REQUEST`, {
        obsCode,
        url: maskServiceKeyInUrl(url),
    });

    const res = await fetch(url);
    const text = await res.text();
    logSurveyResponse(res.status, text);

    let json;
    try {
        json = JSON.parse(text);
    } catch (parseErr) {
        console.error(`${LOG_PREFIX} GetSurveyWaterTempApiService JSON parse error`, parseErr.message);
        throw new Error(`Survey water temp invalid JSON (HTTP ${res.status})`);
    }

    const header = json?.response?.header;
    const code = header?.resultCode ?? header?.resultcode;
    const msg = header?.resultMsg ?? header?.resultmsg ?? '';
    console.log(`${LOG_PREFIX} GetSurveyWaterTempApiService header`, { resultCode: code, resultMsg: msg });

    if (code && String(code) !== '00') {
        throw new Error(`Survey API ${code}: ${msg}`);
    }
    if (!res.ok) {
        throw new Error(`Survey water temp HTTP ${res.status}`);
    }

    const rows = parseSurveyItems(json);
    const { water_temp, obs_time } = pickSurveyWaterTemp(rows);
    console.log(`${LOG_PREFIX} GetSurveyWaterTempApiService parsed`, {
        obsCode,
        rowCount: rows.length,
        water_temp,
        obs_time,
        latestKeys: rows.length ? Object.keys(rows[rows.length - 1]) : [],
    });

    if (water_temp == null || Number.isNaN(water_temp)) {
        throw new Error('조위관측소 실측 수온 데이터 없음');
    }

    return { water_temp, obs_time, obsCode };
}

async function fetchAndParseKma(id) {
    const kmaRes = await fetch(`${KMA_RPT_BASE}${id}.html`, {
        headers: {
            'User-Agent': 'BadaGo/1.0 (kma-beach-proxy)',
            Accept: 'text/html',
        },
    });

    const buffer = Buffer.from(await kmaRes.arrayBuffer());
    const html = decodeEucKr(buffer);

    if (!kmaRes.ok || html.includes('서비스 이용에 불편') || html.length < 5000) {
        throw new Error('KMA page unavailable');
    }

    const parsed = parseWaterWave(html);
    if (!parsed) {
        throw new Error('수온·파고 데이터를 찾을 수 없음');
    }

    const updatedMatch = html.match(/기준[:\s]*(\d{4})년\s*(\d{2})월\s*(\d{2})일[^0-9]*(\d{2}):(\d{2})/);
    let obs_time = null;
    if (updatedMatch) {
        obs_time = `${updatedMatch[1]}-${updatedMatch[2]}-${updatedMatch[3]} ${updatedMatch[4]}:${updatedMatch[5]}`;
    }

    return {
        water_temp: parsed.water_temp,
        wave_height: parsed.wave_height,
        obs_time,
    };
}

/**
 * 1순위: 조위관측소 실측 수온 API (obsCode + DATA_GO_KR_SERVICE_KEY)
 * 2순위: KMA HTML (수온·파고, 실측 수온 실패 시 수온 폴백 / 파고 보완)
 */
async function fetchBeachPayload(kmaBeachId, obsCode) {
    let water_temp = null;
    let wave_height = null;
    let obs_time = null;
    let source = null;
    let surveyObsCode = null;

    if (obsCode && /^DT_\d{4}$/i.test(obsCode)) {
        try {
            const survey = await fetchSurveyWaterTemp(obsCode);
            water_temp = survey.water_temp;
            obs_time = survey.obs_time;
            surveyObsCode = survey.obsCode;
            source = 'khoa-survey';
            console.log(`${LOG_PREFIX} survey OK → khoa-survey`, {
                kmaBeachId,
                obsCode,
                water_temp,
                obs_time,
            });
        } catch (err) {
            console.warn(`${LOG_PREFIX} survey failed → KMA fallback`, {
                kmaBeachId,
                obsCode,
                error: err?.message || String(err),
            });
        }
    }

    try {
        const kma = await fetchAndParseKma(kmaBeachId);
        if (wave_height == null) wave_height = kma.wave_height;
        if (water_temp == null) {
            water_temp = kma.water_temp;
            obs_time = obs_time || kma.obs_time;
            source = 'kma';
        }
    } catch (err) {
        if (water_temp == null) throw err;
    }

    if (water_temp == null) {
        throw new Error('수온 데이터를 가져오지 못함');
    }

    return {
        ok: true,
        source,
        kmaBeachId,
        obsCode: surveyObsCode || obsCode || null,
        water_temp,
        wave_height,
        obs_time,
        cached: false,
    };
}

module.exports = async (req, res) => {
    cors(res);

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const id = String(req.query?.id || '').trim();
    const obsCode = String(req.query?.obsCode || '').trim().toUpperCase();

    if (!id || !/^\d{1,4}$/.test(id)) {
        return res.status(400).json({ error: 'Missing or invalid id parameter' });
    }
    if (obsCode && !/^DT_\d{4}$/.test(obsCode)) {
        return res.status(400).json({ error: 'Invalid obsCode (expected DT_####)' });
    }

    const key = cacheKey(id, obsCode || null);

    console.log(`${LOG_PREFIX} handler`, {
        id,
        obsCode: obsCode || null,
        cacheKey: key,
    });
    logDataGoKrKeyStatus('handler');

    try {
        const cached = getMemoryCached(key);
        if (cached) {
            console.log(`${LOG_PREFIX} cache HIT`, { cacheKey: key, source: cached.source });
            setCacheHeaders(res, true);
            return res.status(200).json(cached);
        }

        const payload = await fetchBeachPayload(id, obsCode || null);
        console.log(`${LOG_PREFIX} payload OK`, {
            cacheKey: key,
            source: payload.source,
            water_temp: payload.water_temp,
            wave_height: payload.wave_height,
        });
        setMemoryCached(key, payload);
        setCacheHeaders(res, false);
        return res.status(200).json(payload);
    } catch (err) {
        console.error(`${LOG_PREFIX} handler error`, {
            id,
            obsCode: obsCode || null,
            error: err?.message || String(err),
        });
        return res.status(err.message.includes('찾을 수 없음') || err.message.includes('없음') ? 404 : 502).json({
            error: err.message || 'Beach data fetch failed',
            kmaBeachId: id,
            obsCode: obsCode || null,
        });
    }
};
