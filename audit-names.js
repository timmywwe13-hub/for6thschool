// Static sanity pass: lists every top-level declaration in the inline game
// script, then reports any capitalised identifier that is *used* as a namespace
// (Foo.bar / Foo(...)) but never declared and is not a known browser/three global.
const fs = require('fs');
const html = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, code = '';
while ((m = re.exec(html)) !== null) if (m[1].length > code.length) code = m[1];

const lines = code.split(/\r?\n/);
const declared = new Set();
lines.forEach(line => {
  let mm;
  if ((mm = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line))) declared.add(mm[1]);
  if ((mm = /^\s*function\s+([A-Za-z_$][\w$]*)/.exec(line))) declared.add(mm[1]);
});

const known = new Set(['THREE', 'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean',
  'Date', 'Error', 'Map', 'Set', 'Promise', 'RegExp', 'Symbol', 'WebGLRenderingContext',
  'Float32Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int32Array', 'Infinity', 'NaN']);

const used = new Map();
lines.forEach((line, i) => {
  if (/^\s*(?:\/\/|\*)/.test(line)) return;
  const stripped = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
  const rx = /(^|[^.\w$])([A-Z][A-Za-z0-9_$]*)\s*(\.|\(|\[)/g;
  let mm;
  while ((mm = rx.exec(stripped)) !== null) {
    const name = mm[2];
    /* `Name:` is an object-literal key (a declaration), and a quoted name is not a use */
    if (new RegExp('(^|[^\\w$.])' + name + '\\s*:').test(stripped)) continue;
    if (stripped.indexOf("'" + name + "'") !== -1 || stripped.indexOf('"' + name + '"') !== -1) continue;
    if (known.has(name)) continue;
    if (!used.has(name)) used.set(name, []);
    used.get(name).push(i + 1);
  }
});
const missing = [];
used.forEach((ls, name) => { if (!declared.has(name)) missing.push([name, ls.length, ls[0]]); });
console.log('declared top-level names: ' + declared.size);
console.log([...declared].sort().join(', '));
console.log('\n--- referenced but NOT declared ---');
missing.sort((a, b) => b[1] - a[1]).forEach(([n, c, l]) => console.log('  ' + n + '  (' + c + ' uses, first at line ' + l + ')'));
if (!missing.length) console.log('  (none)');
