// Writes each inline <script> block to a temp file so `node --check` can report line numbers.
const fs = require('fs');
const path = process.argv[2] || 'index.html';
const html = fs.readFileSync(path, 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0;
const lines = html.split('\n');
while ((m = re.exec(html)) !== null) {
  i++;
  const startLine = html.slice(0, m.index).split('\n').length;
  fs.writeFileSync(`_block${i}.js`, m[1], 'utf8');
  fs.writeFileSync(`_block${i}.start`, String(startLine), 'utf8');
  console.log(`wrote _block${i}.js (html line ${startLine}, ${m[1].length} chars)`);
}
void lines;
