// Applies line-level edits to an inline <script> block inside index.html.
// Usage: node patch-blocks.js index.html 4:4335:delete 4:4336:delete ...
// Line numbers are 1-based within that inline script block (same numbering the
// syntax checker and extract.js report). "delete" removes the line; "dupdel"
// removes the line if it is byte-identical to the previous one.
const fs = require('fs');
const htmlPath = process.argv[2] || 'index.html';
const ops = process.argv.slice(3);
if (!ops.length) { console.error('no edits given'); process.exit(2); }

const html = fs.readFileSync(htmlPath, 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const blocks = [];
let m;
while ((m = re.exec(html)) !== null) {
  blocks.push({ index: blocks.length + 1, start: m.index + m[0].indexOf(m[1]), text: m[1] });
}

const byBlock = new Map();
for (const op of ops) {
  const parts = op.split(':');
  if (parts.length !== 3) { console.error('bad op ' + op); process.exit(2); }
  const b = parseInt(parts[0], 10), line = parseInt(parts[1], 10), action = parts[2];
  if (!byBlock.has(b)) byBlock.set(b, []);
  byBlock.get(b).push({ line, action });
}

let out = '';
let cursor = 0;
for (const blk of blocks) {
  const edits = (byBlock.get(blk.index) || []).slice().sort((a, b) => a.line - b.line);
  if (!edits.length) continue;
  const lines = blk.text.split(/\r?\n/);      // EOL style is normalised to \n
  const eol = blk.text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const removes = [];
  for (const e of edits) {
    const idx = e.line - 1;
    if (idx < 0 || idx >= lines.length) { console.error('block ' + blk.index + ' line ' + e.line + ' out of range'); process.exit(2); }
    if (e.action === 'delete') { removes.push(idx); console.log(`block ${blk.index}: deleting line ${e.line}: ${lines[idx].trim()}`); }
    else if (e.action === 'dupdel') {
      if (lines[idx] === lines[idx - 1]) { removes.push(idx); console.log(`block ${blk.index}: deleting duplicate line ${e.line}: ${lines[idx].trim()}`); }
      else console.log(`block ${blk.index}: line ${e.line} is not a duplicate, kept`);
    } else { console.error('unknown action ' + e.action); process.exit(2); }
  }
  const removed = new Set(removes);
  const next = lines.filter((_, i) => !removed.has(i)).join(eol);
  out += html.slice(cursor, blk.start) + next;
  cursor = blk.start + blk.text.length;
}
out += html.slice(cursor);
if (out === html) console.log('no changes');
else { fs.writeFileSync(htmlPath, out, 'utf8'); console.log('wrote ' + htmlPath); }
