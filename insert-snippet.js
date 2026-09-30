// Inserts a snippet file into an inline <script> block of index.html, before
// the first line matching an anchor regex. EOL style of the host file is kept.
// Usage: node insert-snippet.js index.html <blockIndex> <snippetPath> <anchorRegex>
const fs = require('fs');
const path = process.argv[2] || 'index.html';
const blockIndex = parseInt(process.argv[3], 10);
const snippetPath = process.argv[4];
const anchor = process.argv[5];

const html = fs.readFileSync(path, 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const blocks = [];
let m;
while ((m = re.exec(html)) !== null) {
  blocks.push({ index: blocks.length + 1, start: m.index + m[0].indexOf(m[1]), text: m[1] });
}
const blk = blocks[blockIndex - 1];
if (!blk) throw new Error('no such block ' + blockIndex);
const eol = blk.text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
const lines = blk.text.split(/\r?\n/);
const rx = new RegExp(anchor);
let at = -1;
for (let i = 0; i < lines.length; i++) if (rx.test(lines[i])) { at = i; break; }
if (at < 0) throw new Error('anchor not found: ' + anchor);
if (blk.text.indexOf(fs.readFileSync(snippetPath, 'utf8').split(/\r?\n/)[0]) !== -1) {
  console.log('snippet already present, nothing to do');
  process.exit(0);
}
const snip = fs.readFileSync(snippetPath, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/);
lines.splice(at, 0, ...snip);
const rebuilt = lines.join(eol);
const out = html.slice(0, blk.start) + rebuilt + html.slice(blk.start + blk.text.length);
fs.writeFileSync(path, out, 'utf8');
console.log('inserted ' + snip.length + ' lines before html-' + (blockIndex) + ' block line ' + (at + 1));
