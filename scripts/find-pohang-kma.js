const { TextDecoder } = require('util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(id) {
    try {
        const r = await fetch(`https://www.weather.go.kr/special/CRP/beach/rpt_beach_${id}.html`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!r.ok) return null;
        const h = new TextDecoder('euc-kr').decode(Buffer.from(await r.arrayBuffer()));
        if (h.length < 5000) return null;
        const t = h.match(/id=['"]forname['"][^>]*>([^<]+)/)?.[1]?.trim() || '';
        return { id, title: t };
    } catch {
        return null;
    }
}

async function main() {
    const ids = [268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 327, 328, 329, 330, 331, 332, 333, 334, 335, 336, 337, 338, 339, 340, 341, 342, 343, 344, 345, 346, 347, 348, 349, 350, 351, 352, 353, 354, 355, 356, 357, 358, 359, 360];
    for (const id of ids) {
        const p = await probe(id);
        if (p && /영일|월포|화진|장사|칠포|포항|구룡|경주/i.test(p.title)) console.log(p);
        await sleep(150);
    }
}

main();
