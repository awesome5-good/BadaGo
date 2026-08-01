module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { access_token, per_page = 30, page = 1 } = req.query || {};

  console.log('[strava-activities] called, token:', access_token?.slice(0, 10));

  if (!access_token) {
    return res.status(400).json({ error: 'access_token required' });
  }

  try {
    const url = `https://www.strava.com/api/v3/athlete/activities?per_page=${per_page}&page=${page}`;
    console.log('[strava-activities] fetching:', url);

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json',
      },
    });

    console.log('[strava-activities] strava status:', r.status);
    const data = await r.json();
    console.log('[strava-activities] strava response:', JSON.stringify(data).slice(0, 200));

    return res.status(r.status).json(data);
  } catch (e) {
    console.error('[strava-activities] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
