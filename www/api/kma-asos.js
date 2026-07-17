const ASOS_HOURLY_API = 'https://apis.data.go.kr/1360000/AsosHourlyInfoService/getWthrDataList';
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_TTL_SEC = 300;
const FETCH_TIMEOUT_MS = 8000;
const LOG_PREFIX = '[kma-asos]';

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
        `public, s-maxage=${CACHE_TTL_SEC}, max-age=${CACHE_TTL_SEC}, stale-while-revalidate=60`
    );
    res.setHeader('X-BadaGo-Cache', hit ? 'HIT' : 'MISS');
}

function kstNowParts(date = new Date()) {
    const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    const year = kst.getUTCFullYear();
    const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
    const day = String(kst.getUTCDate()).padStart(2, '0');
    const hour = String(kst.getUTCHours()).padStart(2, '0');
    return { year, month, day, hour, ymd: `${year}${month}${day}` };
}

function maskKeyInUrl(url, paramName = 'serviceKey') {
    const re = new RegExp(`([?&]${paramName}=)([^&]+)`, 'gi');
    return String(url).replace(re, (_, prefix, key) => {
        const k = decodeURIComponent(key);
        if (k.length <= 8) return `${prefix}****`;
        return `${prefix}${k.slice(0, 4)}...${k.slice(-4)}(len=${k.length})`;
    });
}

function getServiceKey() {
    const raw = process.env.KMA_NCST_KEY != null ? String(process.env.KMA_NCST_KEY).trim() : '';
    return raw;
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

async function fetchAsosHourly(stnId, dateYmd, hour) {
    const serviceKey = getServiceKey();
    if (!serviceKey) {
        throw new Error('KMA_NCST_KEY not configured');
    }

    const q = new URLSearchParams({
        serviceKey,
        numOfRows: '1',
        pageNo: '1',
        dataType: 'JSON',
        dataCd: 'ASOS',
        dateCd: 'HR',
        startDt: dateYmd,
        startHh: hour,
        endDt: dateYmd,
        endHh: hour,
        stnIds: String(stnId),
    });
    const url = `${ASOS_HOURLY_API}?${q.toString()}`;
    console.log(`${LOG_PREFIX} REQUEST`, {
        stnId,
        dateYmd,
        hour,
        url: maskKeyInUrl(url),
        timeoutMs: FETCH_TIMEOUT_MS,
    });

    const { res, text } = await fetchWithTimeout(url, 'getWthrDataList');
    console.log(`${LOG_PREFIX} RESPONSE`, {
        stnId,
        httpStatus: res.status,
        bodyPreview: text.slice(0, 500),
    });

    let data;
    try {
        data = JSON.parse(text);
    } catch (_) {
        throw new Error(`ASOS invalid JSON (HTTP ${res.status})`);
    }

    if (!res.ok) {
        throw new Error(`ASOS HTTP ${res.status}`);
    }

    const header = data?.response?.header;
    const resultCode = header?.resultCode ?? header?.resultcode;
    const resultMsg = header?.resultMsg ?? header?.resultmsg ?? '';
    if (resultCode && String(resultCode) !== '00') {
        throw new Error(`ASOS API ${resultCode}: ${resultMsg}`);
    }

    const item = data?.response?.body?.items?.item?.[0];
    if (!item) {
        throw new Error('ASOS item empty');
    }

    return {
        ok: true,
        airTemp: item.ta !== undefined ? parseFloat(item.ta) : null,
        windSpeed: item.ws !== undefined ? parseFloat(item.ws) : null,
        windDir: item.wd !== undefined ? parseFloat(item.wd) : null,
        stnId: String(stnId),
        obsTime: `${dateYmd} ${hour}:00`,
        source: 'kma-asos',
        upstreamUrl: maskKeyInUrl(url),
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

    const stnId = String(req.query?.stnId || '').trim();
    const { year, month, day, hour, ymd } = kstNowParts();
    const dateYmd = String(req.query?.date || ymd).trim();
    const obsHour = String(req.query?.hour || hour).trim().padStart(2, '0');

    if (!stnId || !/^\d+$/.test(stnId)) {
        return res.status(400).json({ error: 'Missing or invalid stnId' });
    }
    if (!/^\d{8}$/.test(dateYmd)) {
        return res.status(400).json({ error: 'Invalid date (expected YYYYMMDD)' });
    }
    if (!/^\d{2}$/.test(obsHour)) {
        return res.status(400).json({ error: 'Invalid hour (expected HH)' });
    }

    const serviceKey = getServiceKey();
    if (!serviceKey) {
        return res.status(500).json({ error: 'KMA_NCST_KEY not configured on server' });
    }

    const cacheKey = `${stnId}:${dateYmd}:${obsHour}`;

    try {
        const cached = getMemoryCached(cacheKey);
        if (cached) {
            setCacheHeaders(res, true);
            return res.status(200).json(cached);
        }

        const payload = await fetchAsosHourly(stnId, dateYmd, obsHour);
        setMemoryCached(cacheKey, payload);
        setCacheHeaders(res, false);
        return res.status(200).json(payload);
    } catch (err) {
        console.error(`${LOG_PREFIX} handler error`, {
            stnId,
            dateYmd,
            hour: obsHour,
            error: err?.message || String(err),
        });
        return res.status(502).json({
            error: err.message || 'ASOS fetch failed',
            stnId,
            date: dateYmd,
            hour: obsHour,
        });
    }
};
