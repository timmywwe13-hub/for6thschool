// Finds identifiers that are used but never declared, with the focus on the
// class of bug that broke the character rig (`root.name = RIG;`): capitalised
// namespaces (`Foo.bar`) and bare ALL_CAPS constants. Comments and string
// literals are stripped first so they cannot produce false hits.
const fs = require('fs');
const html = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, code = '';
while ((m = re.exec(html)) !== null) if (m[1].length > code.length) code = m[1];

const clean = code
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``');

/* every name that any declaration keyword introduces, multi-declarator lines
   included (`const a = 1, b = 2;`) plus function/arrow/catch parameters */
const declared = new Set();
const declRx = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
let d;
while ((d = declRx.exec(clean)) !== null) declared.add(d[1]);
const restRx = /\b(?:const|let|var)\s+[^;]*/g;
while ((d = restRx.exec(clean)) !== null) {
  const stmt = d[0];
  let depth = 0, cur = '';
  const parts = [];
  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i];
    if ('([{'.indexOf(ch) >= 0) depth++;
    else if (')]}'.indexOf(ch) >= 0) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    const t = /^\s*([A-Za-z_$][\w$]*)/.exec(p);
    if (t) declared.add(t[1]);
  }
}
const paramRx = /(?:function\s*[\w$]*|catch)\s*\(([^)]*)\)/g;
while ((d = paramRx.exec(clean)) !== null) {
  d[1].split(',').forEach(function (p) {
    const t = /([A-Za-z_$][\w$]*)/.exec(p);
    if (t) declared.add(t[1]);
  });
}
const methodRx = /(^|[{,;]\s*|\n\s*)([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
while ((d = methodRx.exec(clean)) !== null) {
  d[3].split(',').forEach(function (p) {
    const t = /([A-Za-z_$][\w$]*)/.exec(p);
    if (t) declared.add(t[1]);
  });
}
const arrowRx = /\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/g;
while ((d = arrowRx.exec(clean)) !== null) declared.add(d[1]);

const known = new Set(['THREE', 'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean',
  'Date', 'Error', 'Map', 'Set', 'Promise', 'RegExp', 'Symbol', 'Infinity', 'NaN', 'atob', 'btoa',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'console',
  'document', 'window', 'location', 'navigator', 'fetch', 'performance', 'Uint8Array', 'Float32Array',
  'Uint16Array', 'Uint32Array', 'Int32Array', 'Int16Array', 'ArrayBuffer', 'DataView', 'URL',
  'Blob', 'FileReader', 'Image', 'Audio', 'AudioContext', 'webkitAudioContext',
  'WebGLRenderingContext', 'PointerEvent', 'KeyboardEvent', 'MouseEvent', 'Event', 'File',
  'BroadcastChannel', 'WebSocket', 'localStorage', 'MessageChannel', 'URLSearchParams',
  'Float64Array', 'Int8Array', 'Uint8ClampedArray', 'CSS', 'DOMException', 'TextDecoder', 'TextEncoder']);

const lines = clean.split('\n');
const missing = new Map();
lines.forEach((text, i) => {
  let u;
  /* Foo.bar() / Foo(...)  - a capitalised namespace that must exist */
  const nsRx = /(^|[^.\w$])([A-Z][A-Za-z0-9_$]*)\s*(\.|\()/g;
  while ((u = nsRx.exec(text)) !== null) {
    const name = u[2];
    if (known.has(name) || declared.has(name)) continue;
    if (new RegExp('(^|[^\\w$.])' + name + '\\s*:').test(text)) continue;   // object key
    if (!missing.has(name)) missing.set(name, { kind: 'namespace', count: 0, first: i + 1, sample: text.trim().slice(0, 90) });
    missing.get(name).count++;
  }
  /* a bare ALL_CAPS constant - the `RIG` class of typo */
  const capRx = /(^|[^.\w$'"`])([A-Z][A-Z0-9_]{2,})\b(?!\s*:)/g;
  while ((u = capRx.exec(text)) !== null) {
    const name = u[2];
    if (known.has(name) || declared.has(name)) continue;
    if (name === 'THREE' || name === 'JSON' || name === 'NaN') continue;
    if (!missing.has(name)) missing.set(name, { kind: 'constant', count: 0, first: i + 1, sample: text.trim().slice(0, 90) });
    missing.get(name).count++;
  }
});

const list = [...missing.entries()].sort((a, b) => b[1].count - a[1].count);
console.log('declared names collected: ' + declared.size);
console.log('\n--- used but never declared ---');
if (!list.length) console.log('  (none)');
list.forEach(([n, info]) =>
  console.log('  ' + n + '  [' + info.kind + ', ' + info.count + ' uses, first line ' + info.first + ']\n      ' + info.sample));
