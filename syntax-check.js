// Extracts every inline <script> block from index.html and syntax-checks it.
const fs = require('fs');
const path = process.argv[2] || 'index.html';
const html = fs.readFileSync(path, 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, bad = 0;
const vm = require('vm');
while ((m = re.exec(html)) !== null) {
  i++;
  const code = m[1];
  const line = html.slice(0, m.index).split('\n').length;
  try {
    new vm.Script(code, { filename: `${path}:inline${i}` });
    console.log(`inline script #${i} (html line ${line}, ${code.length} chars): OK`);
  } catch (e) {
    bad++;
    console.log(`inline script #${i} (html line ${line}): SYNTAX ERROR -> ${e.message}`);
  }
}
console.log(bad ? `FAILED: ${bad} block(s) with syntax errors` : `ALL ${i} inline script blocks parse cleanly`);
process.exit(bad ? 1 : 0);
