module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Vercel query 파싱 + URL 직접 파싱 폴백
    let accessToken = req.query && req.query.access_token;
    let perPage = (req.query && req.query.per_page) || '30';
    let page = (req.query && req.query.page) || '1';

    if (!accessToken && req.url) {
        try {
            const u = new URL(req.url, 'http://localhost');
            accessToken = u.searchParams.get('access_token') || accessToken;
            perPage = u.searchParams.get('per_page') || perPage;
            page = u.searchParams.get('page') || page;
        } catch (_) { /* ignore */ }
    }

    if (!accessToken) {
        return res.status(400).json({ error: 'no token' });
    }

    console.log('[strava-activities] token prefix', String(accessToken).slice(0, 10));

    try {
        const r = await fetch(
            `https://www.strava.com/api/v3/athlete/activities?per_page=${encodeURIComponent(perPage)}&page=${encodeURIComponent(page)}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        // 403 포함 Strava 에러 메시지 전문을 그대로 전달
        const data = await r.json();
        if (r.status === 403) {
            console.log('[strava-activities] 403 body', data);
        }
        return res.status(r.status).json(data);
    } catch (err) {
        return res.status(500).json({ error: 'Activities fetch failed' });
    }
};
