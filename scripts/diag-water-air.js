/**
 * 수온(KHOA) · 기온(초단기실황) 진단 스크립트
 * 실행: node scripts/diag-water-air.js
 */
const KHOA_KEY = 'asGG26KX5P9eLKZkroj0Kg==';
const KMA_KEY = '4f518baf8a28ed0f517bba932b36bc8dccb2b3c5c5b16993de091777e0f48ef4';

function kstYmd() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    })
        .format(new Date())
        .replace(/-/g, '');
}

async function dump(label, url) {
    console.log(`\n=== ${label} ===`);
    console.log(url.replace(KHOA_KEY, '****').replace(KMA_KEY, '****'));
    const res = await fetch(url);
    const text = await res.text();
    console.log('HTTP', res.status);
    console.log(text.slice(0, 2500));
}

(async () => {
    const d = kstYmd();
    for (const code of ['DT_0062', 'DT_0005']) {
        await dump(
            `KHOA tideObsTemp ${code}`,
            `https://www.khoa.go.kr/api/oceangrid/tideObsTemp/search.do?ServiceKey=${encodeURIComponent(KHOA_KEY)}&ObsCode=${code}&Date=${d}&ResultType=json`
        );
        await dump(`proxy khoa-hourly ${code}`, `https://bada-go.vercel.app/api/khoa-hourly?obsCode=${code}`);
    }

    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    let h = kst.getUTCHours();
    if (kst.getUTCMinutes() < 40) h -= 1;
    if (h < 0) h = 23;
    const base_time = `${String(h).padStart(2, '0')}00`;
    await dump(
        'UltraSrtNcst nx=99 ny=75',
        `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst?serviceKey=${KMA_KEY}&numOfRows=10&pageNo=1&dataType=JSON&base_date=${d}&base_time=${base_time}&nx=99&ny=75`
    );
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
