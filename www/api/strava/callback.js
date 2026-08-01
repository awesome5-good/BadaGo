const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const REDIRECT_URI = 'https://bada-go.vercel.app/api/strava/callback';
const WEB_APP_URL = 'https://bada-go.vercel.app';
const DEEP_LINK = 'com.badago.app://strava/callback';
const CLIENT_ID = process.env.STRAVA_CLIENT_ID || '250779';
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || 'df1584490a7a20226b50f4e0b0eaf79101cf609f';

function parseQuery(req) {
    const fromReq = req.query || {};
    let fromUrl = {};
    try {
        const rawUrl = req.url || '';
        const u = new URL(rawUrl, 'https://bada-go.vercel.app');
        fromUrl = Object.fromEntries(u.searchParams.entries());
    } catch (_) { /* ignore */ }
    return {
        code: fromReq.code || fromUrl.code || null,
        error: fromReq.error || fromUrl.error || null,
        scope: fromReq.scope || fromUrl.scope || null,
        state: fromReq.state || fromUrl.state || null,
        rawQuery: { ...fromUrl, ...fromReq },
    };
}

async function exchangeCode(code) {
    // redirect_uri는 OAuth 시작 시와 반드시 동일해야 함
    const body = {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
    };
    console.log('[Strava callback] token exchange', {
        redirect_uri: REDIRECT_URI,
        code_prefix: code ? String(code).slice(0, 8) : null,
    });
    const tokenRes = await fetch(STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await tokenRes.json().catch(() => ({}));
    console.log('[Strava callback] token exchange result', {
        status: tokenRes.status,
        has_access: !!data.access_token,
        error: data.message || data.error || null,
    });
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
            // URL 길이 제한 — 프로필 최소 필드만
            const a = data.athlete;
            qs.set('strava_athlete', JSON.stringify({
                id: a.id,
                firstname: a.firstname,
                lastname: a.lastname,
                profile: a.profile,
                profile_medium: a.profile_medium,
            }));
        } catch (_) { /* ignore */ }
    }
    return qs;
}

function redirectToApp(res, qs) {
    const webUrl = `${WEB_APP_URL}/?${qs.toString()}`;
    const deepLink = `${DEEP_LINK}?${qs.toString()}`;
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
      setTimeout(function () { window.location.replace(webUrl); }, 800);
    })();
  </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(html);
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return res.status(405).send('Method not allowed');
    }

    const { code, error, scope, rawQuery } = parseQuery(req);
    console.log('[Strava callback] incoming', {
        method: req.method,
        url: req.url,
        redirect_uri_fixed: REDIRECT_URI,
        has_code: !!code,
        code_prefix: code ? String(code).slice(0, 8) : null,
        error: error || null,
        scope: scope || null,
        query_keys: Object.keys(rawQuery || {}),
    });

    if (error) {
        console.warn('[Strava callback] oauth error param', error);
        const errQs = new URLSearchParams({ strava_error: String(error) });
        return redirectToApp(res, errQs);
    }

    if (!code) {
        console.error('[Strava callback] 400 Missing authorization code', {
            url: req.url,
            query: rawQuery,
            hint: 'Authorization Callback Domain must be bada-go.vercel.app and redirect_uri must be ' + REDIRECT_URI,
        });
        const errQs = new URLSearchParams({
            strava_error: 'missing_code',
            strava_hint: 'check_callback_domain',
        });
        // 앱으로 안내 (bare 400 대신)
        return redirectToApp(res, errQs);
    }

    try {
        const { ok, status, data } = await exchangeCode(String(code));
        if (!ok || !data.access_token) {
            console.error('[Strava callback] token exchange failed', status, data);
            const errQs = new URLSearchParams({
                strava_error: 'token_exchange_failed',
                strava_status: String(status || ''),
                strava_msg: String(data.message || data.error || '').slice(0, 120),
            });
            return redirectToApp(res, errQs);
        }

        const qs = buildTokenQuery(data, scope ? String(scope) : '');
        console.log('[Strava callback] success redirect', {
            access_prefix: String(data.access_token).slice(0, 10),
            scope: data.scope || scope || null,
            expires_at: data.expires_at,
            redirect_uri: REDIRECT_URI,
        });
        return redirectToApp(res, qs);
    } catch (err) {
        console.error('[Strava callback] error', err);
        const errQs = new URLSearchParams({ strava_error: 'callback_failed' });
        return redirectToApp(res, errQs);
    }
};
