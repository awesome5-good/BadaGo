/**
 * /api/strava-callback alias
 * OAuth redirect_uri는 항상 https://bada-go.vercel.app/api/strava/callback 고정.
 * (이 엔드포인트로 code가 와도 동일 핸들러·동일 redirect_uri로 교환)
 */
module.exports = require('./strava/callback.js');
