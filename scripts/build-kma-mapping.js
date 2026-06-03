const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const INDEX_HTML = path.join(__dirname, '..', 'www', 'index.html');

const MANUAL = {
    haeundae: '305',
    gwangan: '306',
    songjeong: '307',
    songdo: '309',
    dadaepo: '308',
    ilgwang: '310',
    sangju: '122',
    hakdong: '136',
    jinha: '311',
    gyeongpo: '262',
    naksan: '347',
    hajodae: '348',
    jeongdongjin: '349',
    maengbang: '350',
    samcheok: '351',
    mangsang: '176',
    goraebul: '353',
    yeongildae: '271',
    wolpo: '273',
    hwajin: '274',
    jangsa: '284',
    chilpo: '272',
    daecheon: '43',
    kkotji: '41',
    mallipo: '44',
    muchangpo: '45',
    chunjangdae: '91',
    anmyeon: '46',
    hyeopjae: '344',
    gwakji: '343',
    jungmun: '352',
    hamdeok: '346',
    gimnyeong: '355',
    woljeongri: '356',
    pyoseon: '172',
    manseongri: '122',
};

async function scrapeMap() {
    const buf = Buffer.from(await (await fetch('https://www.weather.go.kr/w/theme/beach-weather.do', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
    })).arrayBuffer());
    const html = new TextDecoder('euc-kr').decode(buf);

    const map = {};
    const re = /rpt_beach_(\d+)\.(?:html|jsp)[\s\S]*?alt="([^"]+)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const name = m[2].trim();
        if (name && !/새창|로그/.test(name)) map[name] = m[1];
    }

    const re2 = /alt="([^"]+)"[\s\S]{0,400}?rpt_beach_(\d+)\.(?:html|jsp)/gi;
    while ((m = re2.exec(html)) !== null) {
        const name = m[1].trim();
        if (name && !/새창|로그/.test(name)) map[name] = m[2];
    }

    return map;
}

const ALIASES = {
    '상주은모래': ['상주', '신지명사십리'],
    '학동몽돌': ['학동'],
    '망상': ['망상(망상리조트)', '망상리조트'],
    '경포대': ['경포'],
    '만성리': ['신지명사십리', '만성리검은모래'],
    '곽지': ['곽지과물'],
    '함덕': ['함덕서우봉'],
    '표선': ['화순'],
    '고래불': ['고래불해변'],
};

function findInMap(map, beachName) {
    if (map[beachName]) return map[beachName];
    for (const [k, v] of Object.entries(map)) {
        const kn = k.replace(/\(.*\)/, '');
        if (kn === beachName || kn.includes(beachName) || beachName.includes(kn)) return v;
    }
    for (const a of ALIASES[beachName] || []) {
        if (map[a]) return map[a];
        for (const [k, v] of Object.entries(map)) if (k.includes(a) || a.includes(k)) return v;
    }
    return null;
}

async function verifyId(id) {
    const res = await fetch(`https://www.weather.go.kr/special/CRP/beach/rpt_beach_${id}.html`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    const html = new TextDecoder('euc-kr').decode(buf);
    return !html.includes('서비스 이용에 불편') && html.length > 10000;
}

async function main() {
    const map = await scrapeMap();
    console.log('scraped', Object.keys(map).length);

    const block = fs.readFileSync(INDEX_HTML, 'utf8').match(/const ALL_BEACHES = \[([\s\S]*?)\];/)[1];
    const beaches = [];
    for (const line of block.split('\n')) {
        if (!line.includes("id:")) continue;
        beaches.push({
            id: line.match(/id:\s*'([^']+)'/)?.[1],
            name: line.match(/name:\s*'([^']+)'/)?.[1],
        });
    }

    const final = {};
    for (const b of beaches) {
        let id = findInMap(map, b.name) || MANUAL[b.id];
        if (id && !(await verifyId(id))) {
            console.warn('invalid id', b.id, id);
            id = MANUAL[b.id];
        }
        if (!id) id = MANUAL[b.id];
        final[b.id] = id || null;
        console.log(`${b.id}: '${id}' // ${b.name}`);
    }

    fs.writeFileSync(path.join(__dirname, 'kma-final.json'), JSON.stringify({ map, final }, null, 2));
}

main();
