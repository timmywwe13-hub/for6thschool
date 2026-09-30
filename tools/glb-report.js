/* glb-report.js - dumps what a .glb carries (meshes, skins, node names,
   animations) without any dependencies, so a new character model can be
   inspected before it is wired into the skin list. Usage:
     node tools/glb-report.js model.glb [another.glb ...]
   GLB_POSE="thigh,hand,head"  also prints rest-pose world positions of joints
   GLB_ISLANDS=1               also counts the connected rigid islands the
                               CharacterRig piece cutter would find */
const fs = require('fs');

const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error(file + ': not a binary glTF container');
  }
  const declared = buf.readUInt32LE(8);
  const chunkLen = buf.readUInt32LE(12);
  if (buf.toString('ascii', 16, 20) !== 'JSON') throw new Error(file + ': no JSON chunk');
  const json = JSON.parse(buf.toString('utf8', 20, 20 + chunkLen));
  /* the BIN chunk follows the JSON chunk (4-byte aligned length + 'BIN\0') */
  let bin = Buffer.alloc(0);
  let off = 20 + chunkLen;
  if (off + 8 <= buf.length && buf.toString('ascii', off + 4, off + 8) === 'BIN\0') {
    const blen = buf.readUInt32LE(off);
    bin = buf.slice(off + 8, off + 8 + blen);
  }
  return { json, bin, bytes: buf.length, declared };
}

function readAccessor(json, bin, idx) {
  const a = json.accessors[idx];
  const bv = json.bufferViews[a.bufferView];
  const T = CT[a.componentType], n = NCOMP[a.type];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || T.BYTES_PER_ELEMENT * n;
  const out = new T(a.count * n);
  if (stride === T.BYTES_PER_ELEMENT * n) {
    const src = new T(bin.buffer, bin.byteOffset + start, a.count * n);
    out.set(src);
  } else {
    for (let i = 0; i < a.count; i++) {
      const src = new T(bin.buffer, bin.byteOffset + start + i * stride, n);
      out.set(src, i * n);
    }
  }
  return out;
}

/* the same connected-island cut CharacterRig.analyse runs: vertices welded by
   rounded position, triangles unioned across shared vertices */
function countIslands(json, bin) {
  let total = 0;
  const perMesh = [];
  (json.meshes || []).forEach((m) => {
    let meshIslands = 0, meshTris = 0;
    (m.primitives || []).forEach((p) => {
      if (p.indices === undefined || !p.attributes || p.attributes.POSITION === undefined) return;
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      const idx = readAccessor(json, bin, p.indices);
      const parent = new Map();
      function find(r) { while (parent.get(r) !== r) { parent.set(r, parent.get(r)); r = parent.get(r); } return r; }
      function repOf(v) {
        const key = Math.round(pos[v * 3] * 500) + '|' + Math.round(pos[v * 3 + 1] * 500) + '|' + Math.round(pos[v * 3 + 2] * 500);
        if (!parent.has(key)) parent.set(key, key);
        return key;
      }
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = find(repOf(idx[t])), b = find(repOf(idx[t + 1])), c = find(repOf(idx[t + 2]));
        if (a !== b) parent.set(find(b), a);
        if (a !== c) parent.set(find(c), find(a));
      }
      const roots = new Set();
      for (let t = 0; t < idx.length; t++) roots.add(find(repOf(idx[t])));
      meshIslands += roots.size;
      meshTris += idx.length / 3;
    });
    perMesh.push('"' + (m.name || '?') + '": ' + meshIslands + ' island(s), ' + meshTris + ' tris');
    total += meshIslands;
  });
  return { total, perMesh };
}

for (const file of process.argv.slice(2)) {
  const { json, bin, bytes, declared } = readGlb(file);
  const meshes = json.meshes || [], nodes = json.nodes || [], skins = json.skins || [];
  const anims = json.animations || [];
  const mats = json.materials || [], imgs = json.images || [];
  console.log('=== ' + file + ' (' + (bytes / 1048576).toFixed(2) + ' MB' +
    (declared !== bytes ? ', header says ' + declared : '') + ') ===');
  console.log('meshes: ' + meshes.length + '   nodes: ' + nodes.length + '   skins: ' + skins.length +
    '   animations: ' + anims.length + '   materials: ' + mats.length + '   images: ' + imgs.length);
  meshes.forEach((m, i) => {
    const prims = m.primitives || [];
    const skinned = nodes.some((n) => n.mesh === i && n.skin !== undefined);
    console.log('  mesh[' + i + '] "' + (m.name || '?') + '" prims=' + prims.length +
      (skinned ? ' SKINNED' : ' static'));
  });
  if (skins.length) {
    skins.forEach((s, i) => {
      const names = (s.joints || []).map((j) => nodes[j] && nodes[j].name);
      console.log('  skin[' + i + '] ' + names.length + ' joints:');
      for (let k = 0; k < names.length; k++) console.log('    ' + k + '  ' + names[k]);
    });
  }
  if (anims.length) {
    anims.forEach((a, i) => {
      console.log('  anim[' + i + '] "' + (a.name || '?') + '" channels=' + (a.channels || []).length);
    });
  }
  // the scene graph shape: which top nodes carry the meshes
  const scene = (json.scenes || [])[json.scene || 0] || { nodes: [] };
  console.log('  scene roots: ' + (scene.nodes || []).map((i) => '"' + (nodes[i] && nodes[i].name) + '"').join(', '));

  /* GLB_ISLANDS=1: what the rig's piece cutter would find (static models
     need >= 8 pieces to rig up) */
  if (process.env.GLB_ISLANDS && bin.length) {
    const isl = countIslands(json, bin);
    console.log('  rigid islands (the piece cutter): ' + isl.total);
    isl.perMesh.forEach((s) => console.log('    ' + s));
  }

  /* --pose: world position of the named joints in the file's rest pose, from
     the node hierarchy TRS (quaternion math, no deps). Set GLB_POSE to a
     comma-separated list of name fragments. This is what settles "is this a
     T-pose" and which way a model faces before it is wired in. */
  if (process.env.GLB_POSE) {
    const want = process.env.GLB_POSE.split(',').map((s) => s.trim().toLowerCase());
    const parent = new Array(nodes.length).fill(-1);
    nodes.forEach((n, i) => (n.children || []).forEach((c) => { parent[c] = i; }));
    function quatMul(a, b) {
      return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
      ];
    }
    function quatRot(q, v) {
      const x = q[0], y = q[1], z = q[2], w = q[3], vx = v[0], vy = v[1], vz = v[2];
      const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
      return [vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx];
    }
    const wpos = new Array(nodes.length), wrot = new Array(nodes.length);
    function world(i) {
      if (wpos[i]) return;
      const n = nodes[i];
      const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1];
      if (parent[i] < 0) { wpos[i] = t.slice(); wrot[i] = r.slice(); return; }
      world(parent[i]);
      const ps = nodes[parent[i]].scale || [1, 1, 1];
      const sp = [t[0] * ps[0], t[1] * ps[1], t[2] * ps[2]];
      const rp = quatRot(wrot[parent[i]], sp);
      wpos[i] = [wpos[parent[i]][0] + rp[0], wpos[parent[i]][1] + rp[1], wpos[parent[i]][2] + rp[2]];
      wrot[i] = quatMul(wrot[parent[i]], r);
    }
    nodes.forEach((n, i) => {
      if (!n.name) return;
      const nm = n.name.toLowerCase();
      if (!want.some((w) => nm.indexOf(w) !== -1)) return;
      world(i);
      const p = wpos[i].map((v) => +v.toFixed(3));
      console.log('  pose ' + n.name + '  world [' + p.join(', ') + ']');
    });
  }
}
