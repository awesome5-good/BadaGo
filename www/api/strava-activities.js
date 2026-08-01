module.exports = async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(204).end();
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const accessToken = req.query?.access_token;
    if (!accessToken) {
        return res.status(400).json({ error: 'Missing access_token' });
    }

    const perPage = req.query?.per_page || '30';
    const page = req.query?.page || '1';
    const url = `https://www.strava.com/api/v3/athlete/activities?per_page=${encodeURIComponent(perPage)}&page=${encodeURIComponent(page)}`;

    try {
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(500).json({ error: 'Activities fetch failed' });
    }
};
