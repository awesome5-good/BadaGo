const TIDAL_BU_TEMP_API = 'http://www.khoa.go.kr/api/oceangrid/tidalBuTemp/search.do';
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

function getServiceKey() {
    const fromKhoa = process.env.KHOA_SERVICE_KEY != null ? String(process.env.KHOA_SERVICE_KEY).trim() : '';
    if (fromKhoa) return fromKhoa;
    const fromPortal = process.env.DATA_GO_KR_SERVICE_KEY != null ? String(process.env.DATA_GO_KR_SERVICE_KEY).trim() : '';
    return fromPortal;
}

function parseWaterTemp(raw) {
    if (raw == null || raw === '' || raw === '-') return null;
    const n = parseFloat(raw);
    if (Number.isNaN(n) || n < 0 || n > 45) return null;
    return n;
}

function collectRows(json) {
    const rows = json?.result?.data ?? json?.response?.result?.data ?? [];
    if (Array.isArray(rows)) return rows;
    return rows ? [rows] : [];
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

async function fetchTidalBuTemp(obsCode, dateYmd) {
    const serviceKey = getServiceKey();
    if (!serviceKey) {
        throw new Error('KHOA_SERVICE_KEY not configured');
    }

    const q = new URLSearchParams({
        ServiceKey: serviceKey,
        ObsCode: obsCode,
        Date: dateYmd,
        ResultType: 'json',
    });
    const url = `${TIDAL_BU_TEMP_API}?${q.toString()}`;
    console.log(`${LOG_PREFIX} REQUEST`, {
        obsCode,
        date: dateYmd,
        url: maskKeyInUrl(url),
        timeoutMs: FETCH_TIMEOUT_MS,
    });

    const { res, text } = await fetchWithTimeout(url, 'tidalBuTemp');
    console.log(`${LOG_PREFIX} RESPONSE`, {
        obsCode,
        date: dateYmd,
        httpStatus: res.status,
        bodyPreview: text.slice(0, 500),
    });

    if (!text || text.trimStart().startsWith('<')) {
        throw new Error(`tidalBuTemp HTML error response (HTTP ${res.status})`);
    }

    let json;
    try {
        json = JSON.parse(text);
    } catch (_) {
        throw new Error(`tidalBuTemp invalid JSON (HTTP ${res.status})`);
    }

    if (!res.ok) {
        throw new Error(`tidalBuTemp HTTP ${res.status}`);
    }

    const data = collectRows(json);
    if (!data.length) {
        throw new Error('tidalBuTemp data empty');
    }

    const last = data[data.length - 1];
    const water_temp = parseWaterTemp(last.water_temp ?? last.waterTemp);
    if (water_temp === null) {
        throw new Error('tidalBuTemp water_temp invalid');
    }

    return {
        ok: true,
        water_temp,
        obs_time: last.record_time ?? last.recordTime ?? null,
        obsCode,
        date: dateYmd,
        source: 'khoa-tidalBu',
        upstreamUrl: maskKeyInUrl(url),
        cached: false,
    };
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

    if (!obsCode || !/^TW_\d{4}$/.test(obsCode)) {
        return res.status(400).json({ error: 'Missing or invalid obsCode (expected TW_####)' });
    }
    if (!/^\d{8}$/.test(dateYmd)) {
        return res.status(400).json({ error: 'Invalid date (expected YYYYMMDD)' });
    }

    const serviceKey = getServiceKey();
    if (!serviceKey) {
        return res.status(500).json({ error: 'KHOA_SERVICE_KEY not configured on server' });
    }

    const cacheKey = `${obsCode}:${dateYmd}`;

    try {
        const cached = getMemoryCached(cacheKey);
        if (cached) {
            setCacheHeaders(res, true);
            return res.status(200).json(cached);
        }

        const payload = await fetchTidalBuTemp(obsCode, dateYmd);
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
            error: err.message || 'tidalBuTemp fetch failed',
            obsCode,
            date: dateYmd,
        });
    }
};
