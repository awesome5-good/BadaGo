const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { refresh_token: refreshToken } = req.body || {};
    if (!refreshToken) {
        return res.status(400).json({ error: 'Missing refresh_token' });
    }

    const clientId = process.env.STRAVA_CLIENT_ID || '250779';
    const clientSecret = process.env.STRAVA_CLIENT_SECRET;
    if (!clientSecret) {
        return res.status(500).json({ error: 'STRAVA_CLIENT_SECRET not configured' });
    }

    try {
        const tokenRes = await fetch(STRAVA_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            }),
        });

        const data = await tokenRes.json();
        if (!tokenRes.ok) {
            return res.status(tokenRes.status).json(data);
        }

        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ error: 'Token refresh failed' });
    }
};
