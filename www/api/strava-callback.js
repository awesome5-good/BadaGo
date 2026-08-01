const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const REDIRECT_URI = 'https://bada-go.vercel.app/api/strava/callback';
const WEB_APP_URL = 'https://bada-go.vercel.app';
const DEEP_LINK = 'com.badago.app://strava/callback';
const CLIENT_ID = process.env.STRAVA_CLIENT_ID || '250779';
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || 'df1584490a7a20226b50f4e0b0eaf79101cf609f';

async function exchangeCode(code, redirectUri) {
    const tokenRes = await fetch(STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri || REDIRECT_URI,
        }),
    });
    const data = await tokenRes.json();
    return { ok: tokenRes.ok, status: tokenRes.status, data };
}

function buildTokenQuery(data, oauthScope) {
    const qs = new URLSearchParams();
    qs.set('strava_access_token', data.access_token || '');
    qs.set('strava_refresh_token', data.refresh_token || '');
    qs.set('strava_expires_at', String(data.expires_at ?? ''));
    qs.set('strava_scope', data.scope || oauthScope || '');
    if (data.athlete) {
        try {
            qs.set('strava_athlete', JSON.stringify(data.athlete));
        } catch (_) { /* ignore */ }
    }
    return qs;
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return res.status(405).send('Method not allowed');
    }

    const { code, error, scope } = req.query || {};
    // /api/strava-callback 로 등록된 경우를 위한 redirect_uri
    const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'bada-go.vercel.app';
    const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';
    const path = (req.url || '').split('?')[0] || '/api/strava-callback';
    const thisRedirectUri = `${proto}://${host}${path.startsWith('/') ? path : `/${path}`}`;

    if (error) {
        const errQs = new URLSearchParams({ strava_error: String(error) });
        res.setHeader('Location', `${WEB_APP_URL}/?${errQs}`);
        return res.status(302).end();
    }

    if (!code) {
        return res.status(400).send('Missing authorization code');
    }

    try {
        const { ok, status, data } = await exchangeCode(String(code), REDIRECT_URI);
        // 실패 시 alias redirect_uri로 재시도
        let result = { ok, status, data };
        if (!ok || !data.access_token) {
            result = await exchangeCode(String(code), thisRedirectUri);
        }
        if (!result.ok || !result.data.access_token) {
            console.error('[Strava callback] token exchange failed', result.status, result.data);
            const errQs = new URLSearchParams({ strava_error: 'token_exchange_failed' });
            res.setHeader('Location', `${WEB_APP_URL}/?${errQs}`);
            return res.status(302).end();
        }

        const qs = buildTokenQuery(result.data, scope ? String(scope) : '');
        const webUrl = `${WEB_APP_URL}/?${qs.toString()}`;
        const deepLink = `${DEEP_LINK}?${qs.toString()}`;

        console.log('[Strava callback] redirect with tokens', {
            access_prefix: String(result.data.access_token).slice(0, 10),
            scope: result.data.scope || scope || null,
            expires_at: result.data.expires_at,
        });

        const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>바다고 · Strava</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: linear-gradient(170deg, #A8E6FF 0%, #1E7EC8 100%); color: #fff; text-align: center; padding: 24px; }
    p { font-size: 16px; font-weight: 700; line-height: 1.5; }
  </style>
</head>
<body>
  <p id="msg">연결 완료. 앱으로 돌아가는 중...</p>
  <script>
    (function () {
      var deepLink = ${JSON.stringify(deepLink)};
      var webUrl = ${JSON.stringify(webUrl)};
      try { window.location.replace(deepLink); } catch (e) {}
      setTimeout(function () {
        window.location.replace(webUrl);
      }, 800);
    })();
  </script>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(html);
    } catch (err) {
        console.error('[Strava callback] error', err);
        const errQs = new URLSearchParams({ strava_error: 'callback_failed' });
        res.setHeader('Location', `${WEB_APP_URL}/?${errQs}`);
        return res.status(302).end();
    }
};
