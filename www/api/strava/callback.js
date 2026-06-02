const REDIRECT_URI = 'https://bada-go.vercel.app/api/strava/callback';
const DEEP_LINK = 'com.badago.app://strava/callback';

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return res.status(405).send('Method not allowed');
    }

    const { code, error, scope, state } = req.query || {};
    const qs = new URLSearchParams();
    if (code) qs.set('code', String(code));
    if (error) qs.set('error', String(error));
    if (scope) qs.set('scope', String(scope));
    if (state) qs.set('state', String(state));
    const deepLink = qs.toString() ? `${DEEP_LINK}?${qs.toString()}` : DEEP_LINK;

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
  <p id="msg">앱으로 돌아가는 중...</p>
  <script>
    (function () {
      var code = ${JSON.stringify(code || null)};
      var err = ${JSON.stringify(error || null)};
      var deepLink = ${JSON.stringify(deepLink)};
      var redirectUri = ${JSON.stringify(REDIRECT_URI)};

      if (code || err) {
        window.location.replace(deepLink);
      } else {
        document.getElementById('msg').textContent = '인증 정보가 없습니다.';
        return;
      }

      setTimeout(function () {
        if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
          document.getElementById('msg').textContent = '앱으로 돌아가지 않으면 바다고를 다시 열어주세요.';
          return;
        }
        if (!code) {
          document.getElementById('msg').textContent = err ? '로그인이 취소되었습니다.' : '인증에 실패했습니다.';
          return;
        }
        document.getElementById('msg').textContent = '연결 중...';
        fetch('/api/strava/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code, redirect_uri: redirectUri })
        })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
          .then(function (res) {
            if (!res.ok || !res.data.access_token) throw new Error('token failed');
            localStorage.setItem('bada_strava_tokens', JSON.stringify({
              access_token: res.data.access_token,
              refresh_token: res.data.refresh_token,
              expires_at: res.data.expires_at
            }));
            if (res.data.athlete) {
              localStorage.setItem('bada_strava_athlete', JSON.stringify(res.data.athlete));
            }
            window.location.href = '/';
          })
          .catch(function () {
            document.getElementById('msg').textContent = '연결 실패. 다시 시도해주세요.';
          });
      }, 1200);
    })();
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(html);
};
