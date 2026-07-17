const KHOA_BEACH_API = 'https://khoa.go.kr/oceandata/api/beach/search.do';
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_TTL_SEC = 300;
const FETCH_TIMEOUT_MS = 8000;
const LOG_PREFIX = '[khoa-tidalbu]';

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

function maskKeyInUrl(url, paramName = 'ServiceKey') {
    const re = new RegExp(`([?&]${paramName}=)([^&]+)`, 'gi');
    return String(url).replace(re, (_, prefix, key) => {
        const k = decodeURIComponent(key);
        if (k.length <= 8) return `${prefix}****`;
        return `${prefix}${k.slice(0, 4)}...${k.slice(-4)}(len=${k.length})`;
    });
}

function getServiceKey() {
    const fromKhoa = process.env.KHOA_SERVICE_KEY != null ? String(process.env.KHOA_SERVICE_KEY).trim() : '';
    if (fromKhoa) return fromKhoa;
    const fromKma = process.env.KMA_NCST_KEY != null ? String(process.env.KMA_NCST_KEY).trim() : '';
    return fromKma;
}

function parseWaterTemp(raw) {
    if (raw == null || raw === '' || raw === '-') return null;
    const n = parseFloat(raw);
    if (Number.isNaN(n) || n < 0 || n > 45) return null;
    return n;
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

async function fetchBeachWaterTemp(beachCode) {
    const serviceKey = getServiceKey();
    if (!serviceKey) {
        throw new Error('KHOA_SERVICE_KEY (or KMA_NCST_KEY) not configured');
    }

    const url = `${KHOA_BEACH_API}?ServiceKey=${serviceKey}&BeachCode=${beachCode}&ResultType=json`;
    console.log(`${LOG_PREFIX} REQUEST`, {
        beachCode,
        url: maskKeyInUrl(url),
        timeoutMs: FETCH_TIMEOUT_MS,
    });

    const { res, text } = await fetchWithTimeout(url, 'khoa-beach');
    console.log(`${LOG_PREFIX} RESPONSE`, {
        beachCode,
        httpStatus: res.status,
        bodyPreview: text.slice(0, 500),
    });

    let data;
    try {
        data = JSON.parse(text);
    } catch (_) {
        throw new Error(`khoa-beach invalid JSON (HTTP ${res.status})`);
    }

    if (!res.ok) {
        throw new Error(`khoa-beach HTTP ${res.status}`);
    }

    const err = data?.result?.error;
    if (err) {
        throw new Error(`khoa-beach error: ${err}`);
    }

    const item = data?.result?.data?.[0];
    const water_temp = parseWaterTemp(item?.water_temp);
    if (water_temp === null) {
        throw new Error('khoa-beach water_temp empty');
    }

    return {
        ok: true,
        water_temp,
        obs_time: item?.obs_time ?? null,
        obs_post_name: data?.result?.meta?.obs_post_name ?? null,
        beach_name: data?.result?.meta?.beach_name ?? null,
        beachCode,
        source: 'khoa-beach',
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

    const beachCode = String(req.query?.beachCode || 'BCH001').trim().toUpperCase();
    if (!/^BCH\d{3}$/.test(beachCode)) {
        return res.status(400).json({ error: 'Missing or invalid beachCode (expected BCH###)' });
    }

    const serviceKey = getServiceKey();
    if (!serviceKey) {
        return res.status(500).json({ error: 'KHOA_SERVICE_KEY (or KMA_NCST_KEY) not configured on server' });
    }

    try {
        const cached = getMemoryCached(beachCode);
        if (cached) {
            setCacheHeaders(res, true);
            return res.status(200).json(cached);
        }

        const payload = await fetchBeachWaterTemp(beachCode);
        setMemoryCached(beachCode, payload);
        setCacheHeaders(res, false);
        return res.status(200).json(payload);
    } catch (err) {
        console.error(`${LOG_PREFIX} handler error`, {
            beachCode,
            error: err?.message || String(err),
        });
        return res.status(502).json({
            error: err.message || 'khoa beach fetch failed',
            beachCode,
        });
    }
};
