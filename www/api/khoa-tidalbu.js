const TIDE_OBS_TEMP_API = 'https://www.khoa.go.kr/api/oceangrid/tideObsTemp/search.do';
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

function resolveFetch() {
    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch.bind(globalThis);
    }
    try {
        // eslint-disable-next-line global-require, import/no-extraneous-dependencies
        const nodeFetch = require('node-fetch');
        return typeof nodeFetch === 'function' ? nodeFetch : nodeFetch.default;
    } catch (_) {
        return null;
    }
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
    const candidates = [
        process.env.KHOA_SERVICE_KEY,
        process.env.DATA_GO_KR_SERVICE_KEY,
        process.env.KMA_NCST_KEY,
    ];
    for (const raw of candidates) {
        if (raw == null) continue;
        const key = String(raw).trim();
        if (!key || key === 'undefined' || key === 'null') continue;
        return key;
    }
    return '';
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

function isValidObsCode(code) {
    const c = String(code || '').trim().toUpperCase();
    return /^DT_\d{4}$/.test(c) || /^\d{4,6}$/.test(c);
}

function parseWaterTemp(raw) {
    if (raw == null || raw === '' || raw === '-' || raw === '-9' || raw === '-99') return null;
    const n = parseFloat(raw);
    if (Number.isNaN(n) || n < 0 || n > 45) return null;
    return n;
}

/** tideObsTemp result.data 배열에서 최신(마지막 유효) 수온 항목 */
function extractLatestItem(json) {
    if (!json || typeof json !== 'object') return null;

    const result = json.result ?? json.response?.result ?? json;
    let data = result?.data ?? result?.body?.data ?? result?.body?.items?.item ?? null;
    if (data == null) return null;

    if (!Array.isArray(data) && typeof data === 'object') {
        const nested =
            data.tideObsTemp ??
            data.tide_obs_temp ??
            data.item ??
            data.items ??
            data.data;
        if (Array.isArray(nested)) data = nested;
        else if (nested && typeof nested === 'object') data = [nested];
        else if (data.water_temp != null || data.waterTemp != null) data = [data];
        else return null;
    }

    if (!Array.isArray(data) || data.length === 0) return null;

    for (let i = data.length - 1; i >= 0; i--) {
        const row = data[i];
        if (!row || typeof row !== 'object') continue;
        const temp = parseWaterTemp(row.water_temp ?? row.waterTemp);
        if (temp !== null) return row;
    }
    return null;
}

async function fetchWithTimeout(url, label) {
    const fetchFn = resolveFetch();
    if (!fetchFn) {
        throw new Error(
            'fetch is not available (need Node.js 18+ or node-fetch). Check Vercel Node runtime.'
        );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetchFn(url, { signal: controller.signal });
        const text = await res.text();
        return { res, text };
    } catch (err) {
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
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

async function fetchTideObsTemp(obsCode, dateYmd, serviceKey) {
    const q = new URLSearchParams({
        ServiceKey: serviceKey,
        ObsCode: obsCode,
        Date: dateYmd,
        ResultType: 'json',
    });
    const url = `${TIDE_OBS_TEMP_API}?${q.toString()}`;
    console.log(`${LOG_PREFIX} REQUEST`, {
        obsCode,
        date: dateYmd,
        url: maskKeyInUrl(url),
        keyLen: serviceKey.length,
        timeoutMs: FETCH_TIMEOUT_MS,
        hasGlobalFetch: typeof globalThis.fetch === 'function',
    });

    const { res, text } = await fetchWithTimeout(url, 'tideObsTemp');
    const trimmed = String(text || '').trim();
    console.log(`${LOG_PREFIX} RESPONSE`, {
        obsCode,
        date: dateYmd,
        httpStatus: res.status,
        bodyLength: trimmed.length,
        body: trimmed.slice(0, 4000),
    });

    if (!trimmed) {
        throw new Error(`tideObsTemp empty body (HTTP ${res.status})`);
    }
    if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE')) {
        throw new Error(`tideObsTemp HTML error response (HTTP ${res.status})`);
    }

    let data;
    try {
        data = JSON.parse(trimmed);
    } catch (_) {
        throw new Error(`tideObsTemp invalid JSON (HTTP ${res.status})`);
    }

    if (!res.ok) {
        throw new Error(`tideObsTemp HTTP ${res.status}`);
    }

    const apiErr = data?.result?.error ?? data?.result?.meta?.error;
    if (apiErr) {
        throw new Error(`tideObsTemp error: ${apiErr}`);
    }

    const item = extractLatestItem(data);
    if (!item) {
        throw new Error('tideObsTemp data empty (no valid water_temp row)');
    }

    const water_temp = parseWaterTemp(item.water_temp ?? item.waterTemp);
    if (water_temp === null) {
        throw new Error('tideObsTemp water_temp empty or invalid');
    }

    const meta = data?.result?.meta ?? data?.response?.result?.meta ?? {};
    return {
        ok: true,
        water_temp,
        obs_time: item.record_time ?? item.recordTime ?? item.obs_time ?? item.obsTime ?? null,
        obs_post_name: meta.obs_post_name ?? meta.obsPostName ?? null,
        beach_name: meta.beach_name ?? meta.obs_post_name ?? null,
        obsCode,
        date: dateYmd,
        source: 'khoa-tideObsTemp',
        upstreamUrl: maskKeyInUrl(url),
        cached: false,
    };
}

module.exports = async (req, res) => {
    let upstreamUrl = null;
    try {
        cors(res);

        if (req.method === 'OPTIONS') {
            return res.status(204).end();
        }

        if (req.method !== 'GET') {
            return res.status(405).json({ error: 'Method not allowed' });
        }

        if (!resolveFetch()) {
            console.error(`${LOG_PREFIX} fetch unavailable`, { node: process.version });
            return res.status(500).json({
                error: 'fetch is not available; set Vercel Node.js runtime to 18+',
                node: process.version,
            });
        }

        const obsCode = String(req.query?.obsCode || 'DT_0062').trim().toUpperCase();
        if (!isValidObsCode(obsCode)) {
            return res.status(400).json({
                error: 'Missing or invalid obsCode (expected DT_XXXX or numeric station id)',
            });
        }

        const dateYmd = String(req.query?.date || kstDateYmd()).trim();
        if (!/^\d{8}$/.test(dateYmd)) {
            return res.status(400).json({ error: 'Invalid date (expected YYYYMMDD)' });
        }

        const serviceKey = getServiceKey();
        if (!serviceKey) {
            console.error(`${LOG_PREFIX} missing service key`, {
                hasKhoa: process.env.KHOA_SERVICE_KEY != null,
                hasDataGo: process.env.DATA_GO_KR_SERVICE_KEY != null,
                hasKma: process.env.KMA_NCST_KEY != null,
            });
            return res.status(500).json({
                error: 'KHOA_SERVICE_KEY (or DATA_GO_KR_SERVICE_KEY / KMA_NCST_KEY) not configured on server',
                obsCode,
            });
        }

        const cacheKey = `${obsCode}:${dateYmd}`;
        const cached = getMemoryCached(cacheKey);
        if (cached) {
            setCacheHeaders(res, true);
            return res.status(200).json(cached);
        }

        upstreamUrl = `${TIDE_OBS_TEMP_API}?ServiceKey=****&ObsCode=${obsCode}&Date=${dateYmd}&ResultType=json`;
        const payload = await fetchTideObsTemp(obsCode, dateYmd, serviceKey);
        setMemoryCached(cacheKey, payload);
        setCacheHeaders(res, false);
        return res.status(200).json(payload);
    } catch (err) {
        console.error(`${LOG_PREFIX} handler error`, {
            obsCode: req?.query?.obsCode,
            upstreamUrl,
            error: err?.message || String(err),
            stack: err?.stack,
        });
        if (res.headersSent) return undefined;
        return res.status(502).json({
            error: err?.message || 'tideObsTemp fetch failed',
            obsCode: String(req?.query?.obsCode || '').trim().toUpperCase() || null,
            upstreamUrl,
        });
    }
};
