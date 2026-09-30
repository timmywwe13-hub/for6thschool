/* glb-salvage.js - reads what is left of a .glb that travelled through a
   text-oriented upload path. Those re-encode every byte above 0x7F as the three
   UTF-8 bytes of U+FFFD (the same wreckage ANIMATION.md documents for FBX), so
   the header is unreadable and the BIN chunk is gone - but the JSON chunk is
   almost all ASCII, so the model's structure survives. The JSON is located by
   hand (the declared chunk length is part of the damage) and parsed for its
   node/mesh/animation names, animated targets and geometry bounds.
     node tools/glb-salvage.js animated_old_chest.glb */
const fs = require('fs');
const file = process.argv[2];
const buf = fs.readFileSync(file);

/* how much of the file was rewritten: U+FFFD is EF BF BD */
let bad = 0;
for (let i = 0; i + 2 < buf.length; i++) {
  if (buf[i] === 0xEF && buf[i + 1] === 0xBF && buf[i + 2] === 0xBD) { bad++; i += 2; }
}
console.log(file + ': ' + buf.length + ' bytes, ' + bad + ' U+FFFD replacement sequences');
console.log('header: ' + JSON.stringify(buf.toString('utf8', 0, 40)));

let start = buf.indexOf('JSON{');
if (start < 0) { console.log('no JSON chunk found'); process.exit(1); }
start += 4;                       // past the "JSON" chunk-type tag
/* the JSON chunk ends at the last "}" before the BIN chunk marker */
const binAt = buf.indexOf('BIN', start);
let end = buf.lastIndexOf('}', binAt > 0 ? binAt : buf.length);
const text = buf.toString('utf8', start, end + 1);
console.log('JSON chunk: ' + text.length + ' chars at byte ' + start +
            (binAt > 0 ? ' (BIN chunk at ' + binAt + ')' : ' (no BIN marker)'));

let json;
try { json = JSON.parse(text); } catch (e) {
  console.log('JSON does not parse (' + e.message + ') - first 200 chars:');
  console.log(text.slice(0, 200));
  process.exit(1);
}

const nodes = json.nodes || [];
const meshes = json.meshes || [];
const anims = json.animations || [];
const accs = json.accessors || [];
console.log('generator: ' + ((json.asset && json.asset.generator) || '?'));
console.log('nodes ' + nodes.length + '   meshes ' + meshes.length + '   materials ' +
            (json.materials || []).length + '   images ' + (json.images || []).length +
            '   animations ' + anims.length + '   skins ' + (json.skins || []).length);
nodes.forEach(function (n, i) {
  const bits = [];
  if (n.mesh !== undefined) bits.push('mesh[' + n.mesh + ']');
  if (n.translation) bits.push('t ' + n.translation.map(v => +v.toFixed(3)));
  if (n.rotation) bits.push('r ' + n.rotation.map(v => +v.toFixed(3)));
  if (n.scale) bits.push('s ' + n.scale.map(v => +v.toFixed(3)));
  console.log('  node[' + i + '] "' + (n.name || '?') + '" ' + bits.join('  '));
});
meshes.forEach(function (m, i) {
  const prims = (m.primitives || []).map(function (p) {
    const a = accs[p.attributes && p.attributes.POSITION];
    const idx = accs[p.indices];
    const box = a && a.min && a.max
      ? ' bbox [' + a.min.map(v => +v.toFixed(2)) + '] .. [' + a.max.map(v => +v.toFixed(2)) + ']'
      : '';
    return 'verts ' + (a ? a.count : '?') + ' tris ' + (idx ? idx.count / 3 : '?') + box;
  });
  console.log('  mesh[' + i + '] "' + (m.name || '?') + '" ' + prims.join(' | '));
});
anims.forEach(function (a) {
  console.log('  anim "' + (a.name || '?') + '" channels ' + (a.channels || []).length);
  const seen = {};
  (a.channels || []).forEach(function (c) {
    const target = c.target || {};
    const key = nodes[target.node] ? nodes[target.node].name : ('node' + target.node);
    seen[key] = seen[key] || [];
    if (seen[key].indexOf(target.path) < 0) seen[key].push(target.path);
  });
  Object.keys(seen).forEach(function (k) { console.log('    animates "' + k + '": ' + seen[k].join(', ')); });
});
