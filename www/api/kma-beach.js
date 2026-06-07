const { TextDecoder } = require('util');

const KMA_RPT_BASE = 'https://www.weather.go.kr/special/CRP/beach/rpt_beach_';
const SEA_OBS_API = 'https://apihub.kma.go.kr/api/typ01/url/sea_obs.php';
const SURVEY_WATER_TEMP_API =
    'https://apis.data.go.kr/1192136/surveyWaterTemp/GetSurveyWaterTempApiService';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분
const FETCH_TIMEOUT_MS = 5000;
const LOG_PREFIX = '[kma-beach]';
const SURVEY_RESPONSE_LOG_MAX = 4000;

/** @type {Map<string, { expiresAt: number, payload: object }>} */
const memoryCache = new Map();

function maskKeyInUrl(url, paramName) {
    const re = new RegExp(`([?&]${paramName}=)([^&]+)`, 'gi');
    return String(url).replace(re, (_, prefix, key) => {
        const k = decodeURIComponent(key);
        if (k.length <= 8) return `${prefix}****`;
        return `${prefix}${k.slice(0, 4)}...${k.slice(-4)}(len=${k.length})`;
    });
}

function logDataGoKrKeyStatus(context) {
    const raw = process.env.DATA_GO_KR_SERVICE_KEY;
    const trimmed = raw != null ? String(raw).trim() : '';
    const configured = trimmed.length > 0;
    console.log(`${LOG_PREFIX} DATA_GO_KR_SERVICE_KEY check`, {
        context,
        configured,
        length: configured ? trimmed.length : 0,
        preview: configured ? `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}` : null,
    });
}

function logKmaApiHubKeyStatus(context) {
    const raw = process.env.KMA_API_HUB_KEY;
    const trimmed = raw != null ? String(raw).trim() : '';
    const configured = trimmed.length > 0;
    console.log(`${LOG_PREFIX} KMA_API_HUB_KEY check`, {
        context,
        configured,
        length: configured ? trimmed.length : 0,
        preview: configured ? `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}` : null,
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

function cacheKey(id, buoyCode, obsCode) {
    return [id, buoyCode || '', obsCode || ''].join(':');
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

/** sea_obs.php tm — KST 기준 1시간 전 정각 (YYYYMMDDHH) */
function kstSeaObsTm(date = new Date()) {
    const kstOneHourAgo = new Date(date.getTime() + 9 * 60 * 60 * 1000 - 60 * 60 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return (
        `${kstOneHourAgo.getUTCFullYear()}${p(kstOneHourAgo.getUTCMonth() + 1)}${p(kstOneHourAgo.getUTCDate())}` +
        `${p(kstOneHourAgo.getUTCHours())}`
    );
}

function formatKmaHubTm(tm) {
    const s = String(tm || '').trim();
    if (/^\d{12}$/.test(s)) {
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
    }
    return null;
}

function isValidSeaValue(raw) {
    if (raw == null || raw === '' || raw === '-' || raw === '-9' || raw === '-99') return false;
    const n = parseFloat(raw);
    return !Number.isNaN(n) && n > -90;
}

function isValidWaterTemp(raw) {
    if (!isValidSeaValue(raw)) return false;
    const n = parseFloat(raw);
    return n >= 5 && n <= 40;
}

function isValidWaveHeight(raw) {
    if (!isValidSeaValue(raw)) return false;
    const n = parseFloat(raw);
    return n >= 0 && n <= 20;
}

function findSeaObsHeaderLine(lines) {
    for (const line of lines) {
        const cols = line.split(/\s+/);
        if (cols.includes('TW') && (cols.includes('TM') || cols.includes('STN'))) {
            return line;
        }
    }
    return lines[0] || '(응답 비어 있음)';
}

function parseSeaObsText(text, buoyCode) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('sea_obs empty response');

    if (trimmed.startsWith('{')) {
        let json;
        try {
            json = JSON.parse(trimmed);
        } catch (_) {
            throw new Error('sea_obs invalid JSON');
        }
        const status = json?.result?.status;
        const message = json?.result?.message || 'sea_obs API error';
        if (status && Number(status) !== 200) {
            throw new Error(`sea_obs ${status}: ${message}`);
        }
    }

    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let headerIdx = -1;
    let headers = [];
    let headerLine = '';

    for (let i = 0; i < lines.length; i++) {
        const cols = lines[i].split(/\s+/);
        if (cols.includes('TW') && (cols.includes('TM') || cols.includes('STN'))) {
            headers = cols;
            headerIdx = i;
            headerLine = lines[i];
            break;
        }
    }

    if (headerIdx < 0) {
        const fallbackHeader = findSeaObsHeaderLine(lines);
        console.error('[buoy] TW 파싱 실패, 헤더라인:', fallbackHeader);
        throw new Error('sea_obs header(TW) not found');
    }

    const twIdx = headers.indexOf('TW');
    const whIdx = headers.indexOf('WH');
    const tmIdx = headers.indexOf('TM');
    if (twIdx < 0) {
        console.error('[buoy] TW 파싱 실패, 헤더라인:', headerLine);
        throw new Error('sea_obs TW column not found');
    }

    let latest = null;
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#') || /^=+$/.test(line)) continue;
        const cols = line.split(/\s+/);
        if (cols.length < headers.length) continue;
        const tw = cols[twIdx];
        if (!isValidWaterTemp(tw)) continue;
        latest = {
            water_temp: parseFloat(tw),
            wave_height: whIdx >= 0 && isValidWaveHeight(cols[whIdx]) ? parseFloat(cols[whIdx]) : null,
            obs_time: tmIdx >= 0 ? formatKmaHubTm(cols[tmIdx]) : null,
            tm: tmIdx >= 0 ? cols[tmIdx] : null,
        };
    }

    if (!latest) {
        console.error('[buoy] TW 파싱 실패, 헤더라인:', headerLine);
        throw new Error('sea_obs TW data not found');
    }

    console.error('[buoy] TW 파싱 성공:', latest.water_temp);
    return { ...latest, buoyCode };
}

async function fetchWithTimeout(url, label) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        const text = await res.text();
        return { res, text };
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`${label} timeout (${FETCH_TIMEOUT_MS}ms)`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchSeaObsBuoy(buoyCode) {
    console.error('[buoy] key 존재:', !!process.env.KMA_API_HUB_KEY);
    logKmaApiHubKeyStatus('fetchSeaObsBuoy');

    const authKey = process.env.KMA_API_HUB_KEY;
    const trimmedKey = authKey != null ? String(authKey).trim() : '';
    if (!trimmedKey) {
        console.warn(`${LOG_PREFIX} sea_obs SKIP — KMA_API_HUB_KEY empty`);
        throw new Error('KMA_API_HUB_KEY not configured');
    }

    const tm = kstSeaObsTm();
    console.error('[buoy] 호출 시작 stn:', buoyCode, 'tm:', tm);

    const q = new URLSearchParams({
        authKey: trimmedKey,
        stn: String(buoyCode),
        tm,
        help: '0',
    });
    const url = `${SEA_OBS_API}?${q.toString()}`;
    console.log(`${LOG_PREFIX} sea_obs REQUEST`, {
        buoyCode,
        tm,
        url: maskKeyInUrl(url, 'authKey'),
        timeoutMs: FETCH_TIMEOUT_MS,
    });

    console.error('[buoy-key]', !!process.env.KMA_API_HUB_KEY, '길이:', process.env.KMA_API_HUB_KEY?.length);
    console.error('[buoy-url]', url);

    const { res, text: rawText } = await fetchWithTimeout(url, 'sea_obs');
    console.error('[buoy] status:', res.status, 'text:', rawText.slice(0, 300));
    console.log(`${LOG_PREFIX} sea_obs RESPONSE`, {
        httpStatus: res.status,
        bodyLength: rawText.length,
        body: rawText.length <= SURVEY_RESPONSE_LOG_MAX ? rawText : `${rawText.slice(0, SURVEY_RESPONSE_LOG_MAX)}…`,
    });

    if (!res.ok) {
        throw new Error(`sea_obs HTTP ${res.status}`);
    }

    const parsed = parseSeaObsText(rawText, buoyCode);
    console.log(`${LOG_PREFIX} sea_obs parsed`, parsed);
    return parsed;
}

function getSurveyEnvelope(json) {
    return json?.response ?? json;
}

function parseSurveyItems(json) {
    const items = getSurveyEnvelope(json)?.body?.items?.item;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
}

function pickSurveyWaterTemp(rows) {
    if (!rows.length) return { water_temp: null, obs_time: null };
    const latest = rows[rows.length - 1] || rows[0];
    const temp =
        latest?.wtem ??
        latest?.water_temp ??
        latest?.waterTemp ??
        latest?.wt ??
        latest?.TEMP ??
        null;
    const obsRaw =
        latest?.obsrvnDt ??
        latest?.obsvnDt ??
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
        url: maskKeyInUrl(url, 'serviceKey'),
        timeoutMs: FETCH_TIMEOUT_MS,
    });

    const { res, text } = await fetchWithTimeout(url, 'Survey water temp');
    logSurveyResponse(res.status, text);

    let json;
    try {
        json = JSON.parse(text);
    } catch (parseErr) {
        console.error(`${LOG_PREFIX} GetSurveyWaterTempApiService JSON parse error`, parseErr.message);
        throw new Error(`Survey water temp invalid JSON (HTTP ${res.status})`);
    }

    const header = getSurveyEnvelope(json)?.header;
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
 * 1순위: KMA API허브 해양기상부이 (buoyCode + KMA_API_HUB_KEY, TW)
 * 2순위: 조위관측소 실측 수온 API (obsCode + DATA_GO_KR_SERVICE_KEY)
 * 3순위: KMA HTML (수온·파고 폴백 / 파고 보완)
 */
async function fetchBeachPayload(kmaBeachId, buoyCode, obsCode) {
    let water_temp = null;
    let wave_height = null;
    let obs_time = null;
    let source = null;
    let resolvedBuoyCode = null;
    let surveyObsCode = null;

    if (buoyCode && /^\d{4,6}$/.test(String(buoyCode))) {
        try {
            const buoy = await fetchSeaObsBuoy(buoyCode);
            water_temp = buoy.water_temp;
            wave_height = buoy.wave_height;
            obs_time = buoy.obs_time;
            resolvedBuoyCode = buoy.buoyCode;
            source = 'kma-buoy';
            console.log(`${LOG_PREFIX} buoy OK → kma-buoy`, {
                kmaBeachId,
                buoyCode,
                water_temp,
                wave_height,
                obs_time,
            });
        } catch (err) {
            console.warn(`${LOG_PREFIX} buoy failed → survey/KMA fallback`, {
                kmaBeachId,
                buoyCode,
                error: err?.message || String(err),
            });
        }
    }

    if (water_temp == null && obsCode && /^DT_\d{4}$/i.test(obsCode)) {
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
            console.warn(`${LOG_PREFIX} survey failed → KMA HTML fallback`, {
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
        buoyCode: resolvedBuoyCode || buoyCode || null,
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
    const buoyCode = String(req.query?.buoyCode || '').trim();
    const obsCode = String(req.query?.obsCode || '').trim().toUpperCase();

    if (!id || !/^\d{1,4}$/.test(id)) {
        return res.status(400).json({ error: 'Missing or invalid id parameter' });
    }
    if (buoyCode && !/^\d{4,6}$/.test(buoyCode)) {
        return res.status(400).json({ error: 'Invalid buoyCode (expected 4–6 digit station number)' });
    }
    if (obsCode && !/^DT_\d{4}$/.test(obsCode)) {
        return res.status(400).json({ error: 'Invalid obsCode (expected DT_####)' });
    }

    const key = cacheKey(id, buoyCode || null, obsCode || null);

    console.log(`${LOG_PREFIX} handler`, {
        id,
        buoyCode: buoyCode || null,
        obsCode: obsCode || null,
        cacheKey: key,
        query: req.query,
    });
    logKmaApiHubKeyStatus('handler');
    logDataGoKrKeyStatus('handler');

    try {
        const cached = getMemoryCached(key);
        if (cached) {
            console.log(`${LOG_PREFIX} cache HIT`, { cacheKey: key, source: cached.source });
            setCacheHeaders(res, true);
            return res.status(200).json(cached);
        }

        const payload = await fetchBeachPayload(id, buoyCode || null, obsCode || null);
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
            buoyCode: buoyCode || null,
            obsCode: obsCode || null,
            error: err?.message || String(err),
        });
        return res.status(err.message.includes('찾을 수 없음') || err.message.includes('없음') ? 404 : 502).json({
            error: err.message || 'Beach data fetch failed',
            kmaBeachId: id,
            buoyCode: buoyCode || null,
            obsCode: obsCode || null,
        });
    }
};
