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

/**
 * Vercel Node 18+ 는 global fetch 내장.
 * 그 이하·로컬 구버전이면 node-fetch 폴백 시도.
 */
function resolveFetch() {
    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch.bind(globalThis);
    }
    try {
        // optionalDependency — 설치돼 있을 때만
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

/** KHOA_SERVICE_KEY 우선, 없으면 KMA_NCST_KEY. undefined/"undefined"/공백 → 빈 문자열 */
function getServiceKey() {
    const candidates = [
        process.env.KHOA_SERVICE_KEY,
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

function parseWaterTemp(raw) {
    if (raw == null || raw === '' || raw === '-') return null;
    const n = parseFloat(raw);
    if (Number.isNaN(n) || n < 0 || n > 45) return null;
    return n;
}

/** result.data 가 배열·단일 객체·중첩 어느 형태여도 첫 관측 item 추출 */
function extractFirstItem(json) {
    if (!json || typeof json !== 'object') return null;

    const result = json.result ?? json.response?.result ?? null;
    if (!result || typeof result !== 'object') return null;

    let data = result.data;
    if (data == null) return null;

    // 단일 객체
    if (!Array.isArray(data) && typeof data === 'object') {
        if (Array.isArray(data.item)) data = data.item;
        else if (data.item && typeof data.item === 'object') return data.item;
        else if (data.water_temp != null || data.waterTemp != null) return data;
        else return null;
    }

    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0];
    return first && typeof first === 'object' ? first : null;
}

function extractMeta(json) {
    const result = json?.result ?? json?.response?.result ?? null;
    const meta = result?.meta;
    if (!meta || typeof meta !== 'object') {
        return { obs_post_name: null, beach_name: null };
    }
    return {
        obs_post_name: meta.obs_post_name ?? null,
        beach_name: meta.beach_name ?? null,
    };
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

async function fetchBeachWaterTemp(beachCode, serviceKey) {
    const q = new URLSearchParams({
        ServiceKey: serviceKey,
        BeachCode: beachCode,
        ResultType: 'json',
    });
    const url = `${KHOA_BEACH_API}?${q.toString()}`;
    console.log(`${LOG_PREFIX} REQUEST`, {
        beachCode,
        url: maskKeyInUrl(url),
        keyConfigured: true,
        keyLen: serviceKey.length,
        timeoutMs: FETCH_TIMEOUT_MS,
        hasGlobalFetch: typeof globalThis.fetch === 'function',
    });

    const { res, text } = await fetchWithTimeout(url, 'khoa-beach');
    const trimmed = String(text || '').trim();
    console.log(`${LOG_PREFIX} RESPONSE`, {
        beachCode,
        httpStatus: res.status,
        bodyPreview: trimmed.slice(0, 500),
    });

    if (!trimmed) {
        throw new Error(`khoa-beach empty body (HTTP ${res.status})`);
    }
    if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE')) {
        throw new Error(`khoa-beach HTML error response (HTTP ${res.status})`);
    }

    let data;
    try {
        data = JSON.parse(trimmed);
    } catch (_) {
        throw new Error(`khoa-beach invalid JSON (HTTP ${res.status})`);
    }

    if (!res.ok) {
        throw new Error(`khoa-beach HTTP ${res.status}`);
    }

    const apiErr = data?.result?.error ?? data?.result?.meta?.error;
    if (apiErr) {
        throw new Error(`khoa-beach error: ${apiErr}`);
    }

    const item = extractFirstItem(data);
    if (!item) {
        throw new Error('khoa-beach data empty (no result.data[0])');
    }

    const water_temp = parseWaterTemp(item.water_temp ?? item.waterTemp);
    if (water_temp === null) {
        throw new Error('khoa-beach water_temp empty or invalid');
    }

    const meta = extractMeta(data);
    return {
        ok: true,
        water_temp,
        obs_time: item.obs_time ?? item.obsTime ?? null,
        obs_post_name: meta.obs_post_name,
        beach_name: meta.beach_name,
        beachCode,
        source: 'khoa-beach',
        upstreamUrl: maskKeyInUrl(url),
        cached: false,
    };
}

module.exports = async (req, res) => {
    try {
        cors(res);

        if (req.method === 'OPTIONS') {
            return res.status(204).end();
        }

        if (req.method !== 'GET') {
            return res.status(405).json({ error: 'Method not allowed' });
        }

        if (!resolveFetch()) {
            console.error(`${LOG_PREFIX} fetch unavailable`, {
                node: process.version,
            });
            return res.status(500).json({
                error: 'fetch is not available; set Vercel Node.js runtime to 18+',
                node: process.version,
            });
        }

        const beachCode = String(req.query?.beachCode || 'BCH001').trim().toUpperCase();
        if (!/^BCH\d{3}$/.test(beachCode)) {
            return res.status(400).json({ error: 'Missing or invalid beachCode (expected BCH###)' });
        }

        const serviceKey = getServiceKey();
        if (!serviceKey) {
            console.error(`${LOG_PREFIX} missing service key`, {
                hasKhoa: process.env.KHOA_SERVICE_KEY != null,
                hasKma: process.env.KMA_NCST_KEY != null,
            });
            return res.status(500).json({
                error: 'KHOA_SERVICE_KEY (or KMA_NCST_KEY) not configured on server',
                beachCode,
            });
        }

        const cached = getMemoryCached(beachCode);
        if (cached) {
            setCacheHeaders(res, true);
            return res.status(200).json(cached);
        }

        const payload = await fetchBeachWaterTemp(beachCode, serviceKey);
        setMemoryCached(beachCode, payload);
        setCacheHeaders(res, false);
        return res.status(200).json(payload);
    } catch (err) {
        console.error(`${LOG_PREFIX} handler error`, {
            beachCode: req?.query?.beachCode,
            error: err?.message || String(err),
            stack: err?.stack,
        });
        // 이미 헤더를 보냈을 수 있으면 무시
        if (res.headersSent) return undefined;
        return res.status(502).json({
            error: err?.message || 'khoa beach fetch failed',
            beachCode: String(req?.query?.beachCode || '').trim().toUpperCase() || null,
        });
    }
};
