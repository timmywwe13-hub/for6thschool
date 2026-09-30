/* chest-glb.js - the shared glTF reader and small matrix/quaternion kit the
   chest tools work with (the same split the FBX tools use: fbx-read.js is the
   reader, fbx-bake.js and fbx-check.js are its clients). No dependencies.
   Matrices are 16-number arrays, column-major, the order glTF stores. */
const fs = require('fs');

const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error(file + ': not a binary glTF container');
  }
  const chunkLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + chunkLen));
  const off = 20 + chunkLen;
  const blen = buf.readUInt32LE(off);
  return { json: json, bin: buf.slice(off + 8, off + 8 + blen), bytes: buf.length };
}

/* one accessor as a typed array (handles interleaved views) */
function readAccessor(json, bin, idx) {
  const a = json.accessors[idx];
  const bv = json.bufferViews[a.bufferView];
  const T = CT[a.componentType], n = NCOMP[a.type];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || T.BYTES_PER_ELEMENT * n;
  const out = new T(a.count * n);
  for (let i = 0; i < a.count; i++) {
    const src = new T(bin.buffer, bin.byteOffset + start + i * stride, n);
    out.set(src, i * n);
  }
  return out;
}

function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function fromTRS(t, q, s) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1
  ];
}
function xform(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]
  ];
}
function xformDir(m, v) {                 // a direction: rotation only
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2]
  ];
}
function scaleOf(m) {
  return [
    Math.hypot(m[0], m[1], m[2]),
    Math.hypot(m[4], m[5], m[6]),
    Math.hypot(m[8], m[9], m[10])
  ];
}
function invert(m) {
  const a = m;
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;
  return [
    (a[5] * b11 - a[6] * b10 + a[7] * b09) * d, (a[2] * b10 - a[1] * b11 - a[3] * b09) * d,
    (a[13] * b05 - a[14] * b04 + a[15] * b03) * d, (a[10] * b04 - a[9] * b05 - a[11] * b03) * d,
    (a[6] * b08 - a[4] * b11 - a[7] * b07) * d, (a[0] * b11 - a[2] * b08 + a[3] * b07) * d,
    (a[14] * b02 - a[12] * b05 - a[15] * b01) * d, (a[8] * b05 - a[10] * b02 + a[11] * b01) * d,
    (a[4] * b10 - a[5] * b08 + a[7] * b06) * d, (a[1] * b08 - a[0] * b10 - a[3] * b06) * d,
    (a[12] * b04 - a[13] * b02 + a[15] * b00) * d, (a[9] * b02 - a[8] * b04 - a[11] * b00) * d,
    (a[5] * b07 - a[4] * b09 - a[6] * b06) * d, (a[0] * b09 - a[1] * b07 + a[2] * b06) * d,
    (a[13] * b01 - a[12] * b03 - a[14] * b00) * d, (a[8] * b03 - a[9] * b01 + a[10] * b00) * d
  ];
}

function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}
function quatNorm(q) {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function quatInverse(q) { return [-q[0], -q[1], -q[2], q[3]]; }
/* the rotation part of a matrix (assumes no shear) */
function quatFromMat(m) {
  const t = m[0] + m[5] + m[10];
  let q;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [(m[6] - m[9]) / s, (m[8] - m[2]) / s, (m[1] - m[4]) / s, 0.25 * s];
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2;
    q = [0.25 * s, (m[1] + m[4]) / s, (m[8] + m[2]) / s, (m[6] - m[9]) / s];
  } else if (m[5] > m[10]) {
    const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2;
    q = [(m[1] + m[4]) / s, 0.25 * s, (m[2] + m[6]) / s, (m[8] - m[2]) / s];
  } else {
    const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2;
    q = [(m[8] + m[2]) / s, (m[2] + m[6]) / s, 0.25 * s, (m[1] - m[4]) / s];
  }
  return quatNorm(q);
}
/* node world matrices for the pose the file is in (no animation applied) */
function nodeWorldMatrices(json) {
  const nodes = json.nodes;
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach(function (n, i) { (n.children || []).forEach(function (c) { parent[c] = i; }); });
  const local = nodes.map(function (n) {
    return fromTRS(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
  });
  const world = new Array(nodes.length);
  function at(i) {
    if (world[i]) return world[i];
    world[i] = parent[i] < 0 ? local[i] : mul(at(parent[i]), local[i]);
    return world[i];
  }
  nodes.forEach(function (n, i) { at(i); });
  return { world: world, local: local, parent: parent };
}

module.exports = {
  readGlb, readAccessor, mul, fromTRS, xform, xformDir, scaleOf, invert,
  quatMul, quatNorm, quatInverse, quatFromMat, nodeWorldMatrices
};
