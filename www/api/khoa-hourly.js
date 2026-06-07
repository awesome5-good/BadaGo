const TIDE_OBS_TEMP_API = 'https://www.khoa.go.kr/api/oceangrid/tideObsTemp/search.do';
const SURVEY_WATER_TEMP_API =
    'https://apis.data.go.kr/1192136/surveyWaterTemp/GetSurveyWaterTempApiService';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_TTL_SEC = 600;
const FETCH_TIMEOUT_MS = 5000;
const LOG_PREFIX = '[khoa-hourly]';

/** @type {Map<string, { expiresAt: number, payload: object }>} */
const memoryCache = new Map();

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function setCacheHeaders(res, hit) {
    res.setHeader(
        'Cache-Control',
        `public, s-maxage=${CACHE_TTL_SEC}, max-age=${CACHE_TTL_SEC}`
    );
    res.setHeader('X-BadaGo-Cache', hit ? 'HIT' : 'MISS');
}

function kstDateYmd(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    })
        .format(date)
        .replace(/-/g, '');
}

function maskKeyInUrl(url, paramName = 'ServiceKey') {
    const re = new RegExp(`([?&]${paramName}=)([^&]+)`, 'gi');
    return String(url).replace(re, (_, prefix, key) => {
        const k = decodeURIComponent(key);
        if (k.length <= 8) return `${prefix}****`;
        return `${prefix}${k.slice(0, 4)}...${k.slice(-4)}(len=${k.length})`;
    });
}

function isValidWaterTemp(raw) {
    if (raw == null || raw === '' || raw === '-' || raw === '-9' || raw === '-99') return false;
    const n = parseFloat(raw);
    return !Number.isNaN(n) && n >= 5 && n <= 40;
}

function extractHour(recordTime) {
    const s = String(recordTime ?? '').trim();
    if (!s) return null;

    if (/^\d{10,14}$/.test(s)) {
        return s.slice(8, 10);
    }

    const colon = s.match(/(?:\s|T)(\d{2}):\d{2}/);
    if (colon) return colon[1];

    const compact = s.match(/(\d{2})\d{2}$/);
    if (compact && /^\d{4}-\d{2}-\d{2}/.test(s)) return compact[1];

    return null;
}

function collectRows(json) {
    const root = json?.result ?? json?.response?.result ?? json;
    const data = root?.data ?? root?.body?.data ?? root?.body?.items?.item ?? [];

    if (Array.isArray(data)) return data;

    if (data && typeof data === 'object') {
        const nested =
            data.tideObsTemp ??
            data.tide_obs_temp ??
            data.item ??
            data.items ??
            data.data;
        if (Array.isArray(nested)) return nested;
        if (nested && typeof nested === 'object') return [nested];
    }

    return [];
}

function parseHourlyTemps(json) {
    const rows = collectRows(json);
    const byHour = new Map();

    for (const row of rows) {
        const tempRaw =
            row?.water_temp ??
            row?.waterTemp ??
            row?.wtem ??
            row?.TEMP ??
            row?.temperature ??
            row?.temp ??
            null;
        if (!isValidWaterTemp(tempRaw)) continue;

        const timeRaw =
            row?.record_time ??
            row?.recordTime ??
            row?.obsrvnDt ??
            row?.obsvnDt ??
            row?.obs_time ??
            row?.obsTime ??
            row?.datetime ??
            row?.time ??
            null;
        const hour = extractHour(timeRaw);
        if (!hour) continue;

        byHour.set(hour, parseFloat(tempRaw));
    }

    return [...byHour.entries()]
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([hour, temp]) => ({ hour, temp }));
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

function getSurveyEnvelope(json) {
    return json?.response ?? json;
}

function parseSurveyItems(json) {
    const items = getSurveyEnvelope(json)?.body?.items?.item;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
}

function parseSurveyHourlyTemps(json) {
    const byHour = new Map();
    for (const row of parseSurveyItems(json)) {
        const tempRaw = row?.wtem ?? row?.water_temp ?? row?.waterTemp ?? row?.TEMP ?? null;
        if (!isValidWaterTemp(tempRaw)) continue;
        const hour = extractHour(
            row?.obsrvnDt ?? row?.obsvnDt ?? row?.obs_time ?? row?.record_time ?? row?.datetime
        );
        if (!hour) continue;
        byHour.set(hour, parseFloat(tempRaw));
    }
    return [...byHour.entries()]
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([hour, temp]) => ({ hour, temp }));
}

async function fetchSurveyHourly(obsCode, dateYmd) {
    const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
    const trimmedKey = serviceKey != null ? String(serviceKey).trim() : '';
    if (!trimmedKey) {
        throw new Error('DATA_GO_KR_SERVICE_KEY not configured');
    }

    const q = new URLSearchParams({
        serviceKey: trimmedKey,
        type: 'json',
        obsCode,
        reqDate: dateYmd,
        min: '60',
        numOfRows: '300',
        pageNo: '1',
    });
    const url = `${SURVEY_WATER_TEMP_API}?${q.toString()}`;
    console.log(`${LOG_PREFIX} survey fallback REQUEST`, {
        obsCode,
        date: dateYmd,
        url: maskKeyInUrl(url, 'serviceKey'),
        timeoutMs: FETCH_TIMEOUT_MS,
    });

    const { res, text } = await fetchWithTimeout(url, 'surveyWaterTemp');
    let json;
    try {
        json = JSON.parse(text);
    } catch (_) {
        throw new Error(`surveyWaterTemp invalid JSON (HTTP ${res.status})`);
    }

    const header = getSurveyEnvelope(json)?.header;
    const code = header?.resultCode ?? header?.resultcode;
    const msg = header?.resultMsg ?? header?.resultmsg ?? '';
    if (code && String(code) !== '00') {
        throw new Error(`Survey API ${code}: ${msg}`);
    }
    if (!res.ok) {
        throw new Error(`surveyWaterTemp HTTP ${res.status}`);
    }

    const hourly = parseSurveyHourlyTemps(json);
    if (!hourly.length) {
        throw new Error('surveyWaterTemp hourly data empty');
    }

    console.log(`${LOG_PREFIX} survey fallback parsed`, {
        obsCode,
        date: dateYmd,
        count: hourly.length,
    });
    return hourly;
}

async function fetchTideObsTempHourly(obsCode, dateYmd) {
    const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
    const trimmedKey = serviceKey != null ? String(serviceKey).trim() : '';
    if (!trimmedKey) {
        throw new Error('DATA_GO_KR_SERVICE_KEY not configured');
    }

    const q = new URLSearchParams({
        ServiceKey: trimmedKey,
        ObsCode: obsCode,
        Date: dateYmd,
        ResultType: 'json',
    });
    const url = `${TIDE_OBS_TEMP_API}?${q.toString()}`;
    console.log(`${LOG_PREFIX} REQUEST`, {
        obsCode,
        date: dateYmd,
        url: maskKeyInUrl(url),
        timeoutMs: FETCH_TIMEOUT_MS,
    });

    const { res, text } = await fetchWithTimeout(url, 'tideObsTemp');
    if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
        throw new Error('tideObsTemp HTML error response');
    }

    let json;
    try {
        json = JSON.parse(text);
    } catch (_) {
        throw new Error(`tideObsTemp invalid JSON (HTTP ${res.status})`);
    }

    if (!res.ok) {
        throw new Error(`tideObsTemp HTTP ${res.status}`);
    }

    const hourly = parseHourlyTemps(json);
    console.log(`${LOG_PREFIX} parsed`, {
        obsCode,
        date: dateYmd,
        count: hourly.length,
        hours: hourly.map((h) => h.hour).join(','),
    });

    if (!hourly.length) {
        throw new Error('tideObsTemp hourly data empty');
    }

    return hourly;
}

module.exports = async (req, res) => {
    cors(res);

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const obsCode = String(req.query?.obsCode || '').trim().toUpperCase();
    const dateYmd = String(req.query?.date || kstDateYmd()).trim();

    if (!obsCode || !/^DT_\d{4}$/.test(obsCode)) {
        return res.status(400).json({ error: 'Missing or invalid obsCode (expected DT_####)' });
    }
    if (!/^\d{8}$/.test(dateYmd)) {
        return res.status(400).json({ error: 'Invalid date (expected YYYYMMDD)' });
    }

    const cacheKey = `${obsCode}:${dateYmd}`;

    try {
        const cached = getMemoryCached(cacheKey);
        if (cached) {
            setCacheHeaders(res, true);
            return res.status(200).json(cached);
        }

        let hourly;
        let source = 'khoa-tideObsTemp';
        try {
            hourly = await fetchTideObsTempHourly(obsCode, dateYmd);
        } catch (primaryErr) {
            console.warn(`${LOG_PREFIX} tideObsTemp failed, trying survey fallback`, primaryErr.message);
            hourly = await fetchSurveyHourly(obsCode, dateYmd);
            source = 'khoa-survey-hourly';
        }
        const payload = {
            ok: true,
            obsCode,
            date: dateYmd,
            hourly,
            source,
            cached: false,
        };
        setMemoryCached(cacheKey, payload);
        setCacheHeaders(res, false);
        return res.status(200).json(payload);
    } catch (err) {
        console.error(`${LOG_PREFIX} handler error`, {
            obsCode,
            date: dateYmd,
            error: err?.message || String(err),
        });
        return res.status(502).json({
            error: err.message || 'KHOA hourly fetch failed',
            obsCode,
            date: dateYmd,
        });
    }
};
