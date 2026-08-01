const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const REDIRECT_URI = 'https://bada-go.vercel.app/api/strava/callback';

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { code, redirect_uri: redirectUri } = req.body || {};
    console.log('[Strava token] exchange request', {
        has_code: !!code,
        code_prefix: code ? String(code).slice(0, 8) : null,
        body_redirect_uri: redirectUri || null,
        fixed_redirect_uri: REDIRECT_URI,
    });

    if (!code) {
        return res.status(400).json({ error: 'Missing authorization code' });
    }

    const clientId = process.env.STRAVA_CLIENT_ID || '250779';
    const clientSecret = process.env.STRAVA_CLIENT_SECRET || 'df1584490a7a20226b50f4e0b0eaf79101cf609f';
    if (!clientSecret) {
        return res.status(500).json({ error: 'STRAVA_CLIENT_SECRET not configured' });
    }

    // OAuth authorize 때 쓴 redirect_uri와 반드시 동일해야 함
    const tokenBody = {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
    };

    try {
        const tokenRes = await fetch(STRAVA_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tokenBody),
        });

        const data = await tokenRes.json();
        console.log('[Strava token] exchange result', {
            status: tokenRes.status,
            has_access: !!data.access_token,
            error: data.message || data.error || null,
        });
        if (!tokenRes.ok) {
            return res.status(tokenRes.status).json(data);
        }

        return res.status(200).json(data);
    } catch (err) {
        console.error('[Strava token] error', err);
        return res.status(500).json({ error: 'Token exchange failed' });
    }
};
