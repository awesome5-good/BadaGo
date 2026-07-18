const ULTRA_SRT_NCST_API =
    'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst';
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_TTL_SEC = 300;
const FETCH_TIMEOUT_MS = 8000;
const LOG_PREFIX = '[kma-ncst]';

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
    if (!raw || raw === 'undefined' || raw === 'null') return '';
    return raw;
}

/** 매시 40분 이후 → 해당 정시, 이전이면 직전 정시 (KST) */
function getNcstBaseDateTime(date = new Date()) {
    const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    let y = kst.getUTCFullYear();
    let m = kst.getUTCMonth();
    let d = kst.getUTCDate();
    let h = kst.getUTCHours();
    const min = kst.getUTCMinutes();

    if (min < 40) {
        h -= 1;
        if (h < 0) {
            h = 23;
            const prev = new Date(Date.UTC(y, m, d) - 86400000);
            y = prev.getUTCFullYear();
            m = prev.getUTCMonth();
            d = prev.getUTCDate();
        }
    }

    const base_date = `${y}${String(m + 1).padStart(2, '0')}${String(d).padStart(2, '0')}`;
    const base_time = `${String(h).padStart(2, '0')}00`;
    return { base_date, base_time };
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

function parseItems(json) {
    const items = json?.response?.body?.items?.item;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
}

async function fetchUltraSrtNcst(nx, ny, base_date, base_time) {
    const serviceKey = getServiceKey();
    if (!serviceKey) throw new Error('KMA_NCST_KEY not configured');

    const q = new URLSearchParams({
        serviceKey,
        numOfRows: '20',
        pageNo: '1',
        dataType: 'JSON',
        base_date,
        base_time,
        nx: String(nx),
        ny: String(ny),
    });
    const url = `${ULTRA_SRT_NCST_API}?${q.toString()}`;
    console.log(`${LOG_PREFIX} REQUEST`, {
        nx,
        ny,
        base_date,
        base_time,
        url: maskKeyInUrl(url),
    });

    const { res, text } = await fetchWithTimeout(url, 'getUltraSrtNcst');
    console.log(`${LOG_PREFIX} RESPONSE`, {
        httpStatus: res.status,
        bodyPreview: text.slice(0, 800),
    });

    let data;
    try {
        data = JSON.parse(text);
    } catch (_) {
        throw new Error(`UltraSrtNcst invalid JSON (HTTP ${res.status})`);
    }

    const header = data?.response?.header;
    const resultCode = header?.resultCode ?? header?.resultcode;
    const resultMsg = header?.resultMsg ?? header?.resultmsg ?? '';
    if (resultCode && String(resultCode) !== '00') {
        throw new Error(`UltraSrtNcst API ${resultCode}: ${resultMsg}`);
    }
    if (!res.ok) {
        throw new Error(`UltraSrtNcst HTTP ${res.status}`);
    }

    const byCat = {};
    for (const it of parseItems(data)) {
        if (it?.category) byCat[it.category] = it.obsrValue;
    }

    const airTemp = byCat.T1H != null ? parseFloat(byCat.T1H) : null;
    const windSpeed = byCat.WSD != null ? parseFloat(byCat.WSD) : null;
    const windDir = byCat.VEC != null ? parseFloat(byCat.VEC) : null;

    if (airTemp == null || Number.isNaN(airTemp)) {
        throw new Error('UltraSrtNcst T1H empty');
    }

    return {
        ok: true,
        airTemp,
        windSpeed: windSpeed != null && !Number.isNaN(windSpeed) ? windSpeed : null,
        windDir: windDir != null && !Number.isNaN(windDir) ? windDir : null,
        nx: Number(nx),
        ny: Number(ny),
        base_date,
        base_time,
        obsTime: `${base_date.slice(0, 4)}-${base_date.slice(4, 6)}-${base_date.slice(6, 8)} ${base_time.slice(0, 2)}:${base_time.slice(2, 4)}`,
        source: 'kma-ncst',
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

    const nx = String(req.query?.nx || '').trim();
    const ny = String(req.query?.ny || '').trim();
    if (!/^\d{1,3}$/.test(nx) || !/^\d{1,3}$/.test(ny)) {
        return res.status(400).json({ error: 'Missing or invalid nx/ny' });
    }

    const computed = getNcstBaseDateTime();
    const base_date = String(req.query?.base_date || computed.base_date).trim();
    const base_time = String(req.query?.base_time || computed.base_time).trim();

    if (!/^\d{8}$/.test(base_date) || !/^\d{4}$/.test(base_time)) {
        return res.status(400).json({ error: 'Invalid base_date/base_time' });
    }

    if (!getServiceKey()) {
        return res.status(500).json({ error: 'KMA_NCST_KEY not configured on server' });
    }

    const cacheKey = `${nx}:${ny}:${base_date}:${base_time}`;
    try {
        const cached = getMemoryCached(cacheKey);
        if (cached) {
            setCacheHeaders(res, true);
            return res.status(200).json(cached);
        }

        const payload = await fetchUltraSrtNcst(nx, ny, base_date, base_time);
        setMemoryCached(cacheKey, payload);
        setCacheHeaders(res, false);
        return res.status(200).json(payload);
    } catch (err) {
        console.error(`${LOG_PREFIX} handler error`, {
            nx,
            ny,
            base_date,
            base_time,
            error: err?.message || String(err),
        });
        return res.status(502).json({
            error: err.message || 'UltraSrtNcst fetch failed',
            nx,
            ny,
            base_date,
            base_time,
        });
    }
};
