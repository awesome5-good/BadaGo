/** git push 성공 후 Actions·Releases 링크 출력 */
const LINKS = [
    'https://github.com/awesome5-good/BadaGo/actions',
    'https://github.com/awesome5-good/BadaGo/releases/latest',
];
console.log('\n--- GitHub ---');
for (const url of LINKS) console.log(url);
console.log('');
