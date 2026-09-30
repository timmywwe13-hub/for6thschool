// Reports CONFIG keys (and a few named helpers) that are defined but never read,
// so the "every tunable is wired up" claim can be checked.
const fs = require('fs');
const html = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, code = '';
while ((m = re.exec(html)) !== null) if (m[1].length > code.length) code = m[1];

const start = code.indexOf('const CONFIG = {');
const end = code.indexOf('\n};', start);
const body = code.slice(start, end);
const keys = [];
const rx = /^\s{2}([A-Z][A-Z0-9_]*)\s*:/gm;
let mm;
while ((mm = rx.exec(body)) !== null) keys.push(mm[1]);

console.log('CONFIG keys: ' + keys.length);
const unused = [];
for (const k of keys) {
  const uses = (code.match(new RegExp('\\b' + k + '\\b', 'g')) || []).length;
  if (uses <= 1) unused.push(k + ' (1 occurrence)');
}
console.log('\n--- CONFIG keys never read ---');
console.log(unused.length ? unused.join('\n') : '  (none)');

/* unused function parameters are harder to spot: check the few hand-written helpers */
const params = ['moveJitter', 'walk', 'maxOff', 'silent'];
console.log('\n--- suspicious parameters ---');
for (const p of params) {
  const n = (code.match(new RegExp('\\b' + p + '\\b', 'g')) || []).length;
  console.log('  ' + p + ': ' + n + ' occurrence(s)');
}
