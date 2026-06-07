const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'www', 'index.html');

async function main() {
    const html = await (await fetch('https://www.weather.go.kr/w/theme/beach-weather.do', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
    })).text();

    const map = {};
    const re = /rpt_beach_(\d+)\.(?:html|jsp)[^>]*>[\s\S]*?alt="([^"]+)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const name = m[2].trim();
        if (name && !name.includes('새창')) map[name] = m[1];
    }

    // also reverse: alt before href in some layouts
    const re2 = /alt="([^"]+)"[\s\S]{0,300}?rpt_beach_(\d+)\.(?:html|jsp)/gi;
    while ((m = re2.exec(html)) !== null) {
        const name = m[1].trim();
        if (name && !name.includes('새창')) map[name] = m[2];
    }

    console.log('total:', Object.keys(map).length);
    Object.entries(map).sort((a, b) => Number(a[1]) - Number(b[1])).forEach(([k, v]) => console.log(`${v}\t${k}`));

    const aliases = {
        '상주은모래': ['상주', '상주은모래비치'],
        '학동몽돌': ['학동'],
        '망상': ['망상(망상리조트)', '망상리조트'],
        '함덕': ['함덕서우봉'],
        '곽지': ['곽지과물'],
        '고래불': ['고래불해변'],
        '신양': ['신양섭지', '신양섭지코지'],
        '화순': ['표선'],
    };

    const block = fs.readFileSync(INDEX_HTML, 'utf8').match(/const ALL_BEACHES = \[([\s\S]*?)\];/)[1];
    const beaches = [];
    for (const line of block.split('\n')) {
        if (!line.includes("id:")) continue;
        beaches.push({
            id: line.match(/id:\s*'([^']+)'/)?.[1],
            name: line.match(/name:\s*'([^']+)'/)?.[1],
        });
    }

    function findId(name) {
        if (map[name]) return map[name];
        for (const [k, v] of Object.entries(map)) {
            if (k.includes(name) || name.includes(k.replace(/\(.*\)/, ''))) return v;
        }
        for (const a of aliases[name] || []) {
            if (map[a]) return map[a];
            for (const [k, v] of Object.entries(map)) if (k.includes(a)) return v;
        }
        return null;
    }

    console.log('\n--- ALL_BEACHES ---');
    const out = {};
    for (const b of beaches) {
        const id = findId(b.name);
        out[b.id] = id;
        console.log(`${b.id}: kmaBeachId:'${id || ''}' // ${b.name}${id ? '' : ' MISSING'}`);
    }

    fs.writeFileSync(path.join(__dirname, 'kma-beach-ids.json'), JSON.stringify({ map, out }, null, 2));
}

main();
