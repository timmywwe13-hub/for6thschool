/* chest-bake.js - bakes animated_old_chest.glb into chest_model.js, the sidecar
   the game builds its chests from. The model is a skinned mesh of 806 triangles
   whose vertices are each bound 100% to ONE joint (Chest_00 is the box,
   MainAxis_01 the lid, and the strap/latch joints are the ironwork), so the skin
   can be cut into rigid parts and replayed through instance matrices instead of a
   skeleton: 260 chests then stay a handful of draw calls with no mixer at all.

   Per part it writes:
     * the geometry in the pose the clip starts from (the closed chest), put into
       world space: -90 deg about Y so the lid hinges on the back edge like the
       old box did, scaled so the chest is SIZE_X wide, centred on x/z with the
       soles on y = 0
     * SAMPLES evenly spaced samples of that joint's own animation delta
       (world(t) * world(0)^-1, expressed in that same space) - translation,
       quaternion, scale - which the runtime interpolates by how far open the
       chest is. The clip's *shape* is kept; its 3.1 s are not, because a chest
       that takes three seconds to open is not a chest you loot.

   Textures: the base colour image is downscaled to TEX^2 with System.Drawing and
   embedded as a data URI. The normal and metallic-roughness maps are dropped on
   purpose - the game lights everything with MeshLambertMaterial, which has no
   slot for either.

     node tools/chest-bake.js [animated_old_chest.glb] [chest_model.js]
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G3 = require('./chest-glb');

const SRC = process.argv[2] || 'animated_old_chest.glb';
const OUT = process.argv[3] || 'chest_model.js';
const SIZE_X = 1.24;       // the chest's width in the world (the old box's width)
const SAMPLES = 16;        // animation samples per part
const TEX = 512;           // baked base-colour texture size
const TEX_Q = 85;          // JPEG quality for it

/* ---------- read the model ---------- */
const G = G3.readGlb(SRC);
const j = G.json, bin = G.bin;
const nodes = j.nodes, skin = j.skins[0], prim = j.meshes[0].primitives[0];
const W = G3.nodeWorldMatrices(j);
const jointName = function (k) { return nodes[skin.joints[k]].name; };

const pos = G3.readAccessor(j, bin, prim.attributes.POSITION);
const nrm = G3.readAccessor(j, bin, prim.attributes.NORMAL);
const uv = G3.readAccessor(j, bin, prim.attributes.TEXCOORD_0);
const jnt = G3.readAccessor(j, bin, prim.attributes.JOINTS_0);
const wgt = G3.readAccessor(j, bin, prim.attributes.WEIGHTS_0);
const idx = G3.readAccessor(j, bin, prim.indices);
const invBind = G3.readAccessor(j, bin, skin.inverseBindMatrices);
const nVerts = pos.length / 3;
if (!uv || !nrm) throw new Error('the chest needs positions, normals and UVs');

/* ---------- which joint owns each vertex ---------- */
const vertPart = new Int32Array(nVerts);
for (let v = 0; v < nVerts; v++) {
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k++) if (wgt[v * 4 + k] > bw) { bw = wgt[v * 4 + k]; best = jnt[v * 4 + k]; }
  vertPart[v] = best;
  if (bw < 0.999) {
    console.log('  note: vertex ' + v + ' is not rigidly bound (best weight ' + bw.toFixed(3) + ')');
  }
}

/* ---------- bind-pose world positions (the skin applied at rest) ---------- */
const rest = new Float64Array(nVerts * 3);
const restNrm = new Float64Array(nVerts * 3);
for (let v = 0; v < nVerts; v++) {
  const dom = vertPart[v];
  const m = G3.mul(W.world[skin.joints[dom]],
    Array.prototype.slice.call(invBind, dom * 16, dom * 16 + 16));
  const p = G3.xform(m, [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
  rest[v * 3] = p[0]; rest[v * 3 + 1] = p[1]; rest[v * 3 + 2] = p[2];
  const n = G3.xformDir(m, [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]]);
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  restNrm[v * 3] = n[0] / nl; restNrm[v * 3 + 1] = n[1] / nl; restNrm[v * 3 + 2] = n[2] / nl;
}


/* ---------- the clip: duration, and each joint's own animation delta ----------
   world(t) * world(0)^-1 is the transform that carries a rigid part from where
   the clip starts to where it is at t, which is exactly what an instance matrix
   can replay. Rebuilt through the ancestor chain because the parents move too. */
const anim = j.animations[0];
let duration = 0;
anim.channels.forEach(function (c) {
  const input = G3.readAccessor(j, bin, anim.samplers[c.sampler].input);
  duration = Math.max(duration, input[input.length - 1]);
});
const tracks = {};
anim.channels.forEach(function (c) {
  const s = anim.samplers[c.sampler];
  const input = G3.readAccessor(j, bin, s.input);
  const output = G3.readAccessor(j, bin, s.output);
  const n = output.length / input.length;
  const node = c.target.node;
  const t = tracks[node] || (tracks[node] = {});
  t[c.target.path] = function (time) {
    let k = 0;
    for (let i = 0; i < input.length; i++) if (input[i] <= time + 1e-9) k = i;
    const k2 = Math.min(input.length - 1, k + 1);
    const span = (input[k2] - input[k]) || 1;
    const f = Math.min(1, Math.max(0, (time - input[k]) / span));
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(output[k * n + i] + (output[k2 * n + i] - output[k * n + i]) * f);
    }
    return c.target.path === 'rotation' ? G3.quatNorm(out) : out;
  };
});
function worldAt(nodeIdx, time) {
  const chain = [];
  for (let i = nodeIdx; i >= 0; i = W.parent[i]) chain.unshift(i);
  let m = null;
  for (let k = 0; k < chain.length; k++) {
    const n = nodes[chain[k]], t = tracks[chain[k]];
    const tr = t && t.translation ? t.translation(time) : (n.translation || [0, 0, 0]);
    const ro = t && t.rotation ? t.rotation(time) : (n.rotation || [0, 0, 0, 1]);
    const sc = t && t.scale ? t.scale(time) : (n.scale || [1, 1, 1]);
    const local = G3.fromTRS(tr, ro, sc);
    m = m ? G3.mul(m, local) : local;
  }
  return m;
}

/* ---------- where the chest sits in the world ----------
   The model runs 133.6 units along the axis its lid hinges about, so -90 deg
   about Y brings that long axis onto world X and the hinge onto the back edge,
   which is the convention the old box used. The scale, the centring and the
   ground drop are all measured off the model rather than guessed. */
const N = (function () {
  const c = Math.cos(-Math.PI / 2), s = Math.sin(-Math.PI / 2);
  const rot = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (let v = 0; v < nVerts; v++) {
    const p = G3.xformDir(rot, [rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]]);
    for (let a = 0; a < 3; a++) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; }
  }
  const scale = SIZE_X / (max[0] - min[0]);
  const off = [-(min[0] + max[0]) * 0.5 * scale, -min[1] * scale, -(min[2] + max[2]) * 0.5 * scale];
  const S = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1];
  const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, off[0], off[1], off[2], 1];
  return { m: G3.mul(T, G3.mul(S, rot)), scale: scale, rot: rot, off: off };
})();
console.log('chest: ' + SIZE_X.toFixed(2) + ' m wide, scale ' + N.scale.toFixed(5) +
  ', ground drop ' + N.off[1].toFixed(3) + ' m');


/* ---------- build one part per joint ---------- */
function decompose(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r = m.slice();
  r[0] /= sx; r[1] /= sx; r[2] /= sx;
  r[4] /= sy; r[5] /= sy; r[6] /= sy;
  r[8] /= sz; r[9] /= sz; r[10] /= sz;
  const q = G3.quatFromMat(r);
  return { p: [m[12], m[13], m[14]], q: q, s: [sx, sy, sz] };
}
const r4 = function (v) { return Math.round(v * 10000) / 10000; };
const r3 = function (v) { return Math.round(v * 1000) / 1000; };
/* the clip's transform for one joint, expressed in the game's chest space.
   `node` is a NODE index, not a skin slot: the two differ (slot 1 is node 8). */
const invN = G3.invert(N.m);
const deltaAt = function (node, time) {
  const rel = G3.mul(worldAt(node, time), G3.invert(worldAt(node, 0)));
  return G3.mul(N.m, G3.mul(rel, invN));
};

/* ---------- split the mesh into parts ----------
   Every vertex is rigidly bound to one joint, but a shared edge can still join a
   vertex of one part to one of another (the seam where the lid meets the box).
   Such a triangle goes to whichever part most of its corners are in and the odd
   corner is duplicated into that part's vertex list - dropping the triangle
   instead leaves a hole in the chest. */
const parts = [];
const trisOf = {};
for (let t = 0; t + 2 < idx.length; t += 3) {
  const p0 = vertPart[idx[t]], p1 = vertPart[idx[t + 1]], p2 = vertPart[idx[t + 2]];
  const part = (p0 === p1 || p0 === p2) ? p0 : (p1 === p2 ? p1 : p0);
  (trisOf[part] || (trisOf[part] = [])).push(t);
}
const vertsOf = {};
for (let v = 0; v < nVerts; v++) {
  const dom = vertPart[v];
  (vertsOf[dom] || (vertsOf[dom] = [])).push(v);
}
Object.keys(trisOf).forEach(function (key) {
  const slot = Number(key);                    // skin slot = index into jnt/weights
  const node = skin.joints[slot];              // and this is the node it names
  const inPart = Object.create(null);
  const verts = [];
  const add = function (v) {
    if (inPart[v]) return;
    inPart[v] = verts.length + 1;
    verts.push(v);
  };
  (vertsOf[slot] || []).forEach(add);
  trisOf[key].forEach(function (t) { add(idx[t]); add(idx[t + 1]); add(idx[t + 2]); });
  const pos2 = [], nrm2 = [], uv2 = [], tris = [];
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    /* the geometry is the bind pose in the game's space: the keys below are the
       deltas from the pose the clip starts in, which is that same pose */
    const p = G3.xform(N.m, [rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]]);
    pos2.push(r4(p[0]), r4(p[1]), r4(p[2]));
    const n = G3.xformDir(N.m, [restNrm[v * 3], restNrm[v * 3 + 1], restNrm[v * 3 + 2]]);
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    nrm2.push(r3(n[0] / nl), r3(n[1] / nl), r3(n[2] / nl));
    uv2.push(r4(uv[v * 2]), r4(uv[v * 2 + 1]));
  }
  trisOf[key].forEach(function (t) {
    tris.push(inPart[idx[t]] - 1, inPart[idx[t + 1]] - 1, inPart[idx[t + 2]] - 1);
  });
  const keys = [];
  for (let s = 0; s < SAMPLES; s++) {
    const d = decompose(deltaAt(node, (s / (SAMPLES - 1)) * duration));
    keys.push([r4(d.p[0]), r4(d.p[1]), r4(d.p[2]),
               r4(d.q[0]), r4(d.q[1]), r4(d.q[2]), r4(d.q[3]),
               r4(d.s[0]), r4(d.s[1]), r4(d.s[2])]);
  }
  parts.push({ name: jointName(slot), pos: pos2, nrm: nrm2, uv: uv2, idx: tris, keys: keys,
               verts: verts.length, tris: tris.length / 3 });
});

/* ---------- which progress cracks the lid open ----------
   The chest the crosshair is on lifts its lid a little as a "come and open me"
   cue. The model's own clip unlatches the ironwork first and only then swings the
   lid, so the peek is the point in that track where the swinging part has lifted
   PEEK_DEG - measured here rather than guessed, and shipped as `peek`. */
const PEEK_DEG = 12;
const angleOf = function (k) { return 2 * Math.acos(Math.min(1, Math.abs(k[6]))) * 180 / Math.PI; };
/* the lid is the animated part that carries the most geometry: the clasps and the
   strap swing further in places, but they are small ironwork */
const swinging = parts.filter(function (p) {
  const last = p.keys[p.keys.length - 1];
  return angleOf(last) > 1 || Math.hypot(last[0], last[1], last[2]) > 0.01;
}).sort(function (a, b) { return b.verts - a.verts; })[0] || parts[0];
let peek = 0.5;
for (let k = 0; k < swinging.keys.length; k++) {
  if (angleOf(swinging.keys[k]) >= PEEK_DEG) {
    const prev = angleOf(swinging.keys[Math.max(0, k - 1)]);
    const f = (PEEK_DEG - prev) / Math.max(1e-6, angleOf(swinging.keys[k]) - prev);
    peek = ((k - 1 + f) / (swinging.keys.length - 1));
    break;
  }
}
console.log('  the "' + swinging.name + '" part lifts ' + angleOf(swinging.keys[swinging.keys.length - 1]).toFixed(1) +
  ' deg; a ' + PEEK_DEG + ' deg crack sits at progress ' + peek.toFixed(3));

/* biggest part first: the body then the lid, then the ironwork */
parts.sort(function (a, b) { return b.verts - a.verts; });

/* ---------- the texture: base colour, downscaled ---------- */
const baseTex = (j.materials[0].pbrMetallicRoughness || {}).baseColorTexture;
let dataUri = null, texNote = 'none';
if (baseTex && j.textures[baseTex.index]) {
  const im = j.images[j.textures[baseTex.index].source];
  const bv = j.bufferViews[im.bufferView];
  const bytes = G.bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const stamp = Date.now();
  const tmpPng = path.join(os.tmpdir(), 'chest-tex-' + stamp + '.png');
  const tmpJpg = path.join(os.tmpdir(), 'chest-tex-' + stamp + '.jpg');
  const tmpPs1 = path.join(os.tmpdir(), 'chest-tex-' + stamp + '.ps1');
  fs.writeFileSync(tmpPng, bytes);
  fs.writeFileSync(tmpPs1, [
    'param([string]$In,[string]$Out,[int]$Size,[int]$Q)',
    'Add-Type -AssemblyName System.Drawing',
    '$src = [System.Drawing.Image]::FromFile($In)',
    '$bmp = New-Object System.Drawing.Bitmap($Size,$Size)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$g.DrawImage($src,0,0,$Size,$Size)',
    '$g.Dispose()',
    "$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    '$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)',
    '$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]$Q)',
    '$bmp.Save($Out,$codec,$ep)',
    '$bmp.Dispose(); $src.Dispose()'
  ].join('\r\n'), 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', tmpPs1, tmpPng, tmpJpg, String(TEX), String(TEX_Q)], { encoding: 'utf8' });
  if (r.status === 0 && fs.existsSync(tmpJpg)) {
    dataUri = 'data:image/jpeg;base64,' + fs.readFileSync(tmpJpg).toString('base64');
    texNote = TEX + 'x' + TEX + ' jpeg q' + TEX_Q + ' (' +
      Math.round(fs.statSync(tmpJpg).size / 1024) + ' KB, from ' +
      Math.round(bytes.length / 1024) + ' KB ' + im.mimeType + ')';
  } else {
    /* no System.Drawing on this machine: ship the original texture whole */
    dataUri = 'data:image/png;base64,' + bytes.toString('base64');
    texNote = 'original ' + im.mimeType + ' (' + Math.round(bytes.length / 1024) +
      ' KB; the downscale failed: ' + String(r.stderr || r.error || '').slice(0, 120) + ')';
  }
  [tmpPng, tmpJpg, tmpPs1].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } });
}

/* ---------- report + write ---------- */
const bounds = function (part, keyIndex) {
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (let i = 0; i < part.pos.length / 3; i++) {
    const v = [part.pos[i * 3], part.pos[i * 3 + 1], part.pos[i * 3 + 2]];
    let p = v;
    if (keyIndex) {                       // where that part's last key puts it
      const kk = part.keys[part.keys.length - 1];
      p = G3.xform(G3.fromTRS([kk[0], kk[1], kk[2]], [kk[3], kk[4], kk[5], kk[6]], [1, 1, 1]), v);
    }
    for (let a = 0; a < 3; a++) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; }
  }
  return { min: min, max: max };
};
console.log('parts baked from "' + anim.name + '" (' + duration.toFixed(3) + ' s clip):');
const wholeMin = [1e9, 1e9, 1e9], wholeMax = [-1e9, -1e9, -1e9];
parts.forEach(function (p) {
  const b = bounds(p, 0);
  for (let a = 0; a < 3; a++) {
    wholeMin[a] = Math.min(wholeMin[a], b.min[a]);
    wholeMax[a] = Math.max(wholeMax[a], b.max[a]);
  }
  console.log('  ' + p.name.padEnd(14) + ' verts ' + String(p.verts).padStart(4) +
    ' tris ' + String(p.tris).padStart(4) + '  closed bbox [' + b.min.map(function (v) { return v.toFixed(2); }) +
    '] .. [' + b.max.map(function (v) { return v.toFixed(2); }) + ']');
});
console.log('  chest closed: ' + [0, 1, 2].map(function (a) { return (wholeMax[a] - wholeMin[a]).toFixed(3); }).join(' x ') +
  ' m (x,y,z), top at y ' + wholeMax[1].toFixed(3));
const lid = parts.filter(function (p) { return /MainAxis/i.test(p.name); })[0];
if (lid) {
  const ob = bounds(lid, 1);
  console.log('  lid opened: bbox [' + ob.min.map(function (v) { return v.toFixed(2); }) + '] .. [' +
    ob.max.map(function (v) { return v.toFixed(2); }) + ']  (top of the lid at y ' + ob.max[1].toFixed(3) + ' m)');
}

const head = [
  '/* chest_model.js - generated by tools/chest-bake.js from ' + path.basename(SRC) + '.',
  '   The chest model as the game needs it: the skinned mesh cut into rigid parts',
  '   (each vertex of the source is bound 100% to one joint), each part carrying the',
  '   animation delta of its joint sampled ' + SAMPLES + ' times across the clip, and the',
  '   base colour texture. Rebuild with:  node tools/chest-bake.js',
  '   Source clip: "' + anim.name + '" ' + duration.toFixed(3) + ' s, baked texture: ' + texNote + ' */',
  'window.CHEST_MODEL = {',
  '  source: ' + JSON.stringify(path.basename(SRC)) + ',',
  '  clip: ' + JSON.stringify(anim.name || '') + ',',
  '  duration: ' + duration.toFixed(3) + ',',
  '  peek: ' + peek.toFixed(4) + ',          // progress at which the lid has cracked ' + PEEK_DEG + ' deg',
  '  lid: ' + JSON.stringify(swinging.name) + ',   // the part the aim-peek lifts',
  '  size: [' + [0, 1, 2].map(function (a) { return r4(wholeMax[a] - wholeMin[a]); }).join(', ') + '],',
  '  texture: ' + JSON.stringify(dataUri) + ',',
  '  parts: ['
];
parts.forEach(function (p, i) {
  head.push('    { name: ' + JSON.stringify(p.name) + ', verts: ' + p.verts + ', tris: ' + p.tris +
    ', lift: ' + (p === swinging ? 'true' : 'false') + ',');
  head.push('      pos: ' + JSON.stringify(p.pos) + ',');
  head.push('      nrm: ' + JSON.stringify(p.nrm) + ',');
  head.push('      uv: ' + JSON.stringify(p.uv) + ',');
  head.push('      idx: ' + JSON.stringify(p.idx) + ',');
  head.push('      keys: [' + p.keys.map(function (k) { return '[' + k.join(',') + ']'; }).join(',\n               ') + '] }' +
    (i === parts.length - 1 ? '' : ','));
});
head.push('  ]');
head.push('};');
fs.writeFileSync(OUT, head.join('\n') + '\n', 'utf8');
console.log('wrote ' + OUT + ': ' + Math.round(fs.statSync(OUT).size / 1024) + ' KB, texture ' + texNote);
