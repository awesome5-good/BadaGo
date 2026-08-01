const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';

module.exports = async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(204).end();
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { refresh_token: refreshToken } = req.body || {};
    if (!refreshToken) {
        return res.status(400).json({ error: 'Missing refresh_token' });
    }

    try {
        const response = await fetch(STRAVA_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: '250779',
                client_secret: 'df1584490a7a20226b50f4e0b0eaf79101cf609f',
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
        });
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(500).json({ error: 'Token refresh failed' });
    }
};
