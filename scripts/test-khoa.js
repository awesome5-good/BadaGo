/**
 * KHOA BCH001~BCH100 스캔 + 기상청 해수욕장(광안리 306) + 조위관측소 실측 수온 API 테스트
 * 실행: node scripts/test-khoa.js
 *   FULL_KHOA_SCAN=1  — BCH001~100 전체 스캔 포함 (기본 생략, 느림)
 *   DATA_GO_KR_SERVICE_KEY=... — 공공데이터포털 인증키 (15142506)
 */

const KHOA_SERVICE_KEY = 'asGG26KX5P9eLKZkroj0Kg==';
const KHOA_BEACH_API = 'https://khoa.go.kr/oceandata/api/beach/search.do';

/** 국립해양조사원_조위관측소 실측 수온 — https://www.data.go.kr/data/15142506/openapi.do */
const SURVEY_WATER_TEMP_API =
    'https://apis.data.go.kr/1192136/surveyWaterTemp/GetSurveyWaterTempApiService';

/** 해운대(35.158, 129.160) 인근 — 기장 전용 DT 조위관측소 없음, 부산 DT_0005가 최근접 */
const HAEUNDAE_LAT = 35.158;
const HAEUNDAE_LON = 129.16;

const SURVEY_WATER_TEMP_CANDIDATES = [
    { obsCode: 'DT_0005', name: '부산', lat: 35.0963, lon: 129.035, role: '조위관측소 · 해운대 인근 최근접 DT' },
    { obsCode: 'HB_0001', name: '한수원_기장', lat: 35.1824, lon: 129.235, role: '해양관측부이(기장) · obsCode 호환 여부 확인' },
    { obsCode: 'DT_0009', name: '포항', lat: 36.0471, lon: 129.384, role: '비교용 조위관측소' },
];

const KMA_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'text/html, application/json, */*',
    Referer: 'https://www.weather.go.kr/w/theme/beach-weather.do',
};

function beachCodeNum(n) {
    return `BCH${String(n).padStart(3, '0')}`;
}

async function fetchKhoaByCode(code) {
    const url = `${KHOA_BEACH_API}?ServiceKey=${encodeURIComponent(KHOA_SERVICE_KEY)}&ResultType=json&BeachCode=${encodeURIComponent(code)}`;
    const res = await fetch(url);
    const json = await res.json();
    const meta = json.result?.meta || {};
    const err = json.result?.error;
    const data = json.result?.data?.[0];

    if (err) return { ok: false, reason: String(err) };
    if (!data) return { ok: false, reason: 'no data' };

    return {
        ok: true,
        beach_name: meta.beach_name || data.beach_name || '',
        obs_post_name: meta.obs_post_name || '',
        water_temp: data.water_temp ?? null,
    };
}

async function scanKhoaBch001to100() {
    console.log('=== KHOA API BCH001 ~ BCH100 스캔 ===\n');

    const ok = [];
    const fail = [];

    for (let n = 1; n <= 100; n++) {
        const code = beachCodeNum(n);
        try {
            const r = await fetchKhoaByCode(code);
            if (r.ok) ok.push({ code, ...r });
            else fail.push({ code, reason: r.reason });
        } catch (e) {
            fail.push({ code, reason: e.message });
        }
    }

    console.log(`데이터 반환: ${ok.length}개 / 없음·오류: ${fail.length}개\n`);
    console.log('[코드 · 해수욕장명 · 관측소]');
    for (const r of ok) {
        const obs = r.obs_post_name ? ` · ${r.obs_post_name}` : '';
        const temp = r.water_temp != null ? ` · 수온 ${r.water_temp}°C` : '';
        console.log(`  ${r.code}  ${r.beach_name || '(이름 없음)'}${obs}${temp}`);
    }

    if (fail.length) {
        console.log('\n[데이터 없음]');
        for (const f of fail) console.log(`  ${f.code}  ${f.reason}`);
    }

    return { ok, fail };
}

/** 기상청 해수욕장 HTML에서 수온·파고 파싱 (EUC-KR ℃ 깨짐 대비: 19.3℃/0.8m 형식) */
function parseKmaWaterWave(html) {
    const tdMatch = html.match(/<td[^>]*align=['"]center['"][^>]*>\s*(\d+(?:\.\d+)?)[^<]*?\/\s*(\d+(?:\.\d+)?)\s*m\s*<\/td>/i);
    if (tdMatch) return { water_temp: parseFloat(tdMatch[1]), wave_height: parseFloat(tdMatch[2]) };

    const loose = html.match(/(\d{1,2}(?:\.\d+)?)[^\d<]{0,4}\/\s*(\d+(?:\.\d+)?)\s*m/);
    if (loose && parseFloat(loose[1]) >= 10 && parseFloat(loose[1]) <= 35) {
        return { water_temp: parseFloat(loose[1]), wave_height: parseFloat(loose[2]) };
    }

    return null;
}

async function testKmaBeachGwanggan() {
    console.log('\n=== 기상청 해수욕장 API 조사 (광안리 ID 306) ===\n');

    const tests = [
        {
            label: '구 URL (서비스 종료)',
            url: 'https://www.kma.go.kr/special/CRP/beach/306',
            expectJson: false,
        },
        {
            label: '날씨누리 해수욕장 리포트 HTML (키 없음)',
            url: 'https://www.weather.go.kr/special/CRP/beach/rpt_beach_306.html',
            expectJson: false,
        },
        {
            label: '공공데이터 OpenAPI (서비스키 필수)',
            url: 'https://apis.data.go.kr/1360000/BeachFcstInfoService/getBeachFcst?beachId=306&dataType=JSON&numOfRows=1&pageNo=1',
            expectJson: true,
        },
    ];

    let gwanganWater = null;

    for (const t of tests) {
        try {
            const res = await fetch(t.url, { headers: KMA_HEADERS, redirect: 'follow' });
            const text = await res.text();
            const isJson = /json/i.test(res.headers.get('content-type') || '') || /^\s*[\{\[]/.test(text);
            const isErrorPage = text.includes('서비스 이용에 불편') || text.includes('weather.go.kr/w/');

            console.log(`[${t.label}]`);
            console.log(`  ${t.url}`);
            console.log(`  HTTP ${res.status} · ${(res.headers.get('content-type') || '').slice(0, 40)} · ${text.length} bytes`);
            console.log(`  JSON=${isJson} · 종료/안내페이지=${isErrorPage}`);

            if (t.url.includes('rpt_beach_306')) {
                const parsed = parseKmaWaterWave(text);
                const ultra = text.match(/<dd[^>]*class=['"]?long['"]?[^>]*><strong>(\d+(?:\.\d+)?)<\/strong>/);
                if (parsed) {
                    gwanganWater = parsed.water_temp;
                    console.log(`  ★ 광안리 수온(HTML 파싱): ${parsed.water_temp}°C · 파고 ${parsed.wave_height}m`);
                } else {
                    console.log('  수온/파고 테이블 파싱 실패');
                }
                if (ultra) console.log(`  초단기예보 기온(참고): ${ultra[1]}°C`);
            } else if (isJson && text.length < 5000) {
                console.log(`  body: ${text.slice(0, 200)}`);
            }
            console.log('');
        } catch (e) {
            console.log(`[${t.label}] ERROR ${e.message}\n`);
        }
    }

    console.log('--- 기상청 결론 ---');
    console.log('· kma.go.kr/special/CRP/beach/306 → 2021년 이후 미운영(에러/리다이렉트 안내)');
    console.log('· 실제 데이터: weather.go.kr/special/CRP/beach/rpt_beach_{id}.html (서버 HTML, API 키 불필요)');
    console.log('· JSON OpenAPI(수온 등): data.go.kr「기상청_전국 해수욕장날씨조회서비스」— 인증키 필수');
    if (gwanganWater != null) {
        console.log(`· 광안리(306) 수온: ${gwanganWater}°C (HTML fetch 성공)`);
    } else {
        console.log('· 광안리(306) 수온: 파싱 실패');
    }

    return gwanganWater;
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildSurveyWaterTempUrl(obsCode, serviceKey) {
    const q = new URLSearchParams({
        type: 'json',
        obsCode,
        numOfRows: '5',
        pageNo: '1',
        min: '60',
    });
    if (serviceKey) q.set('serviceKey', serviceKey);
    return `${SURVEY_WATER_TEMP_API}?${q.toString()}`;
}

function getSurveyEnvelope(json) {
    return json?.response ?? json;
}

function parseSurveyWaterTempResponse(json) {
    const items = getSurveyEnvelope(json)?.body?.items?.item;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
}

async function fetchSurveyWaterTemp(obsCode, serviceKey) {
    const url = buildSurveyWaterTempUrl(obsCode, serviceKey);
    const t0 = Date.now();
    const res = await fetch(url);
    const text = await res.text();
    const elapsedMs = Date.now() - t0;
    let json = null;
    try {
        json = JSON.parse(text);
    } catch (_) {
        return { ok: false, url, status: res.status, elapsedMs, reason: text.slice(0, 120) };
    }

    const header = getSurveyEnvelope(json)?.header;
    const code = header?.resultCode ?? header?.resultcode;
    const msg = header?.resultMsg ?? header?.resultmsg ?? '';
    if (code && String(code) !== '00') {
        return { ok: false, url, status: res.status, elapsedMs, reason: `${code}: ${msg}` };
    }

    const rows = parseSurveyWaterTempResponse(json);
    const latest = rows[rows.length - 1] || rows[0];
    const temp =
        latest?.wtem ??
        latest?.water_temp ??
        latest?.waterTemp ??
        latest?.wt ??
        latest?.TEMP ??
        null;

    return {
        ok: rows.length > 0 && temp != null && !Number.isNaN(parseFloat(temp)),
        url,
        status: res.status,
        elapsedMs,
        rows: rows.length,
        latest,
        water_temp: temp != null ? parseFloat(temp) : null,
        obs_time: latest?.obsrvnDt ?? latest?.obsvnDt ?? latest?.obs_time ?? null,
        obsvtrNm: latest?.obsvtrNm ?? null,
        rawKeys: latest ? Object.keys(latest) : [],
        totalCount: getSurveyEnvelope(json)?.body?.totalCount ?? null,
    };
}

async function testSurveyWaterTempApi() {
    console.log('\n=== 국립해양조사원 조위관측소 실측 수온 API (data.go.kr 15142506) ===\n');
    console.log(`엔드포인트: ${SURVEY_WATER_TEMP_API}`);
    console.log('참고: https://www.data.go.kr/data/15142506/openapi.do\n');

    const portalKey = process.env.DATA_GO_KR_SERVICE_KEY || '';
    const khoaKey = KHOA_SERVICE_KEY;

    console.log('[API 키 없이 호출]');
    const noKeyUrl = buildSurveyWaterTempUrl('DT_0005', null);
    console.log(`  URL: ${noKeyUrl.replace(/serviceKey=[^&]+/, 'serviceKey=(없음)')}`);
    try {
        const noKey = await fetchSurveyWaterTemp('DT_0005', null);
        console.log(`  HTTP ${noKey.status} · ok=${noKey.ok} · ${noKey.reason || `rows=${noKey.rows}`}`);
        if (noKey.latest) console.log('  sample:', JSON.stringify(noKey.latest).slice(0, 200));
    } catch (e) {
        console.log(`  ERROR ${e.message}`);
    }

    console.log('\n[기존 KHOA 해수욕장 키로 호출 — 15142506 전용 키 필요 여부]');
    const khoaTry = await fetchSurveyWaterTemp('DT_0005', khoaKey);
    console.log(`  DT_0005 부산: HTTP ${khoaTry.status} · ${khoaTry.ok ? `수온 ${khoaTry.water_temp}°C (${khoaTry.rows}건)` : khoaTry.reason}`);

    if (!portalKey) {
        console.log('\n[DATA_GO_KR_SERVICE_KEY 미설정 — 공공데이터포털 활용신청 키로 재실행 필요]');
        console.log('  export DATA_GO_KR_SERVICE_KEY="발급키" && node scripts/test-khoa.js');
    } else {
        console.log('\n[DATA_GO_KR_SERVICE_KEY — DT_0005 직접 호출 (응답 시간·데이터)]');
        const dt5 = await fetchSurveyWaterTemp('DT_0005', portalKey);
        console.log(`  obsCode=DT_0005 · HTTP ${dt5.status} · ${dt5.elapsedMs}ms`);
        if (dt5.ok) {
            console.log(`  관측소: ${dt5.obsvtrNm} · 수온 ${dt5.water_temp}°C · 관측시각 ${dt5.obs_time}`);
            console.log(`  건수: ${dt5.rows} / totalCount ${dt5.totalCount}`);
            console.log(`  최신 레코드: ${JSON.stringify(dt5.latest)}`);
        } else {
            console.log(`  FAIL: ${dt5.reason || 'unknown'}`);
            if (dt5.latest) console.log(`  latest keys: ${dt5.rawKeys?.join(', ')}`);
        }

        console.log('\n[DATA_GO_KR_SERVICE_KEY로 호출 — 후보 관측소]');
        for (const st of SURVEY_WATER_TEMP_CANDIDATES) {
            const r = await fetchSurveyWaterTemp(st.obsCode, portalKey);
            const dist = haversineKm(HAEUNDAE_LAT, HAEUNDAE_LON, st.lat, st.lon).toFixed(1);
            console.log(
                `  ${st.obsCode} ${st.name} (해운대 ${dist}km): ` +
                    (r.ok && r.water_temp != null
                        ? `수온 ${r.water_temp}°C · ${r.rows}건 · ${r.elapsedMs}ms`
                        : `FAIL ${r.reason || r.status} · ${r.elapsedMs}ms`)
            );
        }
    }

    const ranked = [...SURVEY_WATER_TEMP_CANDIDATES]
        .map((st) => ({ ...st, dist: haversineKm(HAEUNDAE_LAT, HAEUNDAE_LON, st.lat, st.lon) }))
        .sort((a, b) => a.dist - b.dist);

    console.log('\n[해운대 인근 관측소 (거리순)]');
    for (const st of ranked) {
        console.log(`  ${st.dist.toFixed(1)}km · ${st.obsCode} ${st.name} — ${st.role}`);
    }

    console.log('\n--- 조위관측소 실측 수온 API 결론 ---');
    console.log('· serviceKey 필수 — 키 없이 호출 시 HTTP 401 (API 키 없이 사용 불가)');
    console.log('· KHOA 해수욕장 API 키(asGG26…)와 동일 키로는 401 — data.go.kr에서 「조위관측소 실측 수온」 별도 활용신청 필요');
    console.log('· obsCode는 DT_####(조위관측소) 형식 — 기장 인근은 HB_0001(부이)만 있고 DT 기장 코드는 없음');
    console.log(`· 해운대 수온 조회 시 obsCode 후보: ${ranked[0].obsCode} (${ranked[0].name}, ${ranked[0].dist.toFixed(1)}km)`);
}

async function main() {
    if (process.env.FULL_KHOA_SCAN === '1') {
        const khoa = await scanKhoaBch001to100();
        if (khoa.fail.length) process.exitCode = 1;
    } else {
        console.log('(BCH001~100 스캔 생략 — FULL_KHOA_SCAN=1 로 전체 실행)\n');
    }
    await testKmaBeachGwanggan();
    await testSurveyWaterTempApi();
}


main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
