const { TextDecoder } = require('util');

const KMA_RPT_BASE = 'https://www.weather.go.kr/special/CRP/beach/rpt_beach_';

function decodeEucKr(buffer) {
    try {
        return new TextDecoder('euc-kr').decode(buffer);
    } catch (_) {
        return buffer.toString('binary');
    }
}

function parseWaterWave(html) {
    const tdMatch = html.match(
        /<td[^>]*align=['"]center['"][^>]*>\s*(\d+(?:\.\d+)?)[^<]*?\/\s*(\d+(?:\.\d+)?)\s*m\s*<\/td>/i
    );
    if (tdMatch) {
        return { water_temp: parseFloat(tdMatch[1]), wave_height: parseFloat(tdMatch[2]) };
    }

    const loose = html.match(/(\d{1,2}(?:\.\d+)?)[^\d<]{0,8}\/\s*(\d+(?:\.\d+)?)\s*m/i);
    if (loose) {
        const water = parseFloat(loose[1]);
        if (water >= 10 && water <= 35) {
            return { water_temp: water, wave_height: parseFloat(loose[2]) };
        }
    }

    return null;
}

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
    cors(res);

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const id = String(req.query?.id || '').trim();
    if (!id || !/^\d{1,4}$/.test(id)) {
        return res.status(400).json({ error: 'Missing or invalid id parameter' });
    }

    try {
        const kmaRes = await fetch(`${KMA_RPT_BASE}${id}.html`, {
            headers: {
                'User-Agent': 'BadaGo/1.0 (kma-beach-proxy)',
                Accept: 'text/html',
            },
        });

        const buffer = Buffer.from(await kmaRes.arrayBuffer());
        const html = decodeEucKr(buffer);

        if (!kmaRes.ok || html.includes('서비스 이용에 불편') || html.length < 5000) {
            return res.status(502).json({ error: 'KMA page unavailable', kmaBeachId: id });
        }

        const parsed = parseWaterWave(html);
        if (!parsed) {
            return res.status(404).json({ error: '수온·파고 데이터를 찾을 수 없음', kmaBeachId: id });
        }

        const updatedMatch = html.match(/기준[:\s]*(\d{4})년\s*(\d{2})월\s*(\d{2})일[^0-9]*(\d{2}):(\d{2})/);
        let obs_time = null;
        if (updatedMatch) {
            obs_time = `${updatedMatch[1]}-${updatedMatch[2]}-${updatedMatch[3]} ${updatedMatch[4]}:${updatedMatch[5]}`;
        }

        return res.status(200).json({
            ok: true,
            source: 'kma',
            kmaBeachId: id,
            water_temp: parsed.water_temp,
            wave_height: parsed.wave_height,
            obs_time,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'KMA fetch failed', kmaBeachId: id });
    }
};
