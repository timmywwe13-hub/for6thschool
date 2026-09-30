// =====================================================================
// Bakes the Mixamo walk/run/crouch/gun-carry FBX clips onto the game's
// character rig.
//
//   node tools/fbx-bake.js                 (uses the CLIPS list below)
//   node tools/fbx-bake.js --report        (print what it found, write nothing)
//
// Why a build step: index.html must stay one self-contained file that runs
// straight off the disk, so it cannot ship an FBX importer, and the FBX clips
// carry a 65-bone Mixamo skeleton Freddy does not have. This tool reads the
// clips, retargets their motion onto the 14 hinges CharacterRig builds, and
// writes freddy_anims.js - a plain <script> sidecar the page loads exactly
// like the model's base64 sidecar (see the PLAYER CHARACTER section).
//
// The retarget is the standard rest-relative one: for a source bone b,
//   D(b,t) = Rworld_src(b,t) * Rref_src(b)^-1        (a world-space rotation)
// and the matching target bone aims for Rworld_tgt = D(b,t) * Rworld_tgt_rest(b),
// so its local rotation is  Rworld_tgt(parent)^-1 * Rworld_tgt(b). Rref is the
// source's own rest orientation - except for chains whose rest pose is nothing
// like the target's (Mixamo's T-pose arms against Freddy's, which hang at his
// sides): those are measured from the clip's *average world orientation*
// instead, so what transfers is the swing around the middle of the clip, riding
// on the pose the model was actually built in.
// =====================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./fbx-read');

/* ---------- quaternion + 3x3 helpers (row-major, three.js conventions) ---------- */
const D2R = Math.PI / 180;
const clamp1 = v => v < -1 ? -1 : (v > 1 ? 1 : v);

/* FBX writes Euler *extrinsic* orders; three.js (and this tool) use intrinsic
   ones, so FBX order 0 ("XYZ") is ZYX here. Same table as three's FBXLoader. */
const EULER_ORDER = ['ZYX', 'YZX', 'XZY', 'ZXY', 'YXZ', 'XYZ'];
const AXIS_Q = {
  x: a => [Math.cos(a / 2), Math.sin(a / 2), 0, 0],
  y: a => [Math.cos(a / 2), 0, Math.sin(a / 2), 0],
  z: a => [Math.cos(a / 2), 0, 0, Math.sin(a / 2)]
};
/* intrinsic Euler in the given order (radians) -> quaternion */
function qFromEuler(x, y, z, order) {
  const v = { x, y, z };
  const q = a => AXIS_Q[a](v[a]);
  return qMul(qMul(q(order[0].toLowerCase()), q(order[1].toLowerCase())),
              q(order[2].toLowerCase()));
}
const qMul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
const qConj = q => [q[0], -q[1], -q[2], -q[3]];
/* shortest-arc spherical interpolation, used to ease a bone's reference
   orientation from its rest pose toward the clip's own average pose */
function qSlerp(a, b, w) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9995) return qNorm([a[0] + (bb[0] - a[0]) * w, a[1] + (bb[1] - a[1]) * w,
                                a[2] + (bb[2] - a[2]) * w, a[3] + (bb[3] - a[3]) * w]);
  const theta = Math.acos(clamp1(d)) * w;
  const s = Math.sin(theta), c = Math.cos(theta);
  const sa = Math.sin(Math.acos(clamp1(d))) || 1;
  const w0 = c - d * s / sa, w1 = s / sa;
  return qNorm([a[0] * w0 + bb[0] * w1, a[1] * w0 + bb[1] * w1,
                a[2] * w0 + bb[2] * w1, a[3] * w0 + bb[3] * w1]);
}
function qNorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function qToMat3(q) {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
          2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
          2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
}
function mMul(a, b) {
  const out = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return out;
}
const mT = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const mApply = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
                          m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
                          m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
function mToQuat(m) {
  const t = m[0] + m[4] + m[8];
  let s;
  if (t > 0) {
    s = Math.sqrt(t + 1) * 2;
    return [0.25 * s, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s];
  }
  if (m[0] > m[4] && m[0] > m[8]) {
    s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    return [(m[7] - m[5]) / s, 0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s];
  }
  if (m[4] > m[8]) {
    s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    return [(m[2] - m[6]) / s, (m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s];
  }
  s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
  return [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s];
}
/* quaternion -> Euler XYZ in radians, matching THREE.Euler order 'XYZ' */
function qToEulerXYZ(q) {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  return [Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
          Math.asin(clamp1(2 * (w * y - z * x))),
          Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))];
}

/* Which source bone drives which hinge of the rig in index.html, and how much
   of that clip's average pose to remove. The arms need it (Mixamo is a T-pose,
   Freddy's arms hang at his sides); the rest of the body already shares the
   source's reference stance, so they keep their clip's true average. */
const MAP = {
  torso:     { src: 'Hips',         neutral: 0.0 },
  head:      { src: 'Neck',         neutral: 0.0 },
  shoulderL: { src: 'LeftArm',      neutral: 1.0 },
  elbowL:    { src: 'LeftForeArm',  neutral: 1.0 },
  handL:     { src: 'LeftHand',     neutral: 1.0 },
  shoulderR: { src: 'RightArm',     neutral: 1.0 },
  elbowR:    { src: 'RightForeArm', neutral: 1.0 },
  handR:     { src: 'RightHand',    neutral: 1.0 },
  hipL:      { src: 'LeftUpLeg',    neutral: 0.0 },
  kneeL:     { src: 'LeftLeg',      neutral: 0.0 },
  footL:     { src: 'LeftFoot',     neutral: 0.0 },
  hipR:      { src: 'RightUpLeg',   neutral: 0.0 },
  kneeR:     { src: 'RightLeg',     neutral: 0.0 },
  footR:     { src: 'RightFoot',    neutral: 0.0 }
};

/* Freddy's hinges in the shape CharacterRig builds them: local space is in
   metres, soles on y = 0, facing +Z, and L sits at -x (the rig's own sign). */
const J = { neck: 0.760, shoulder: 0.720, elbow: 0.600, wrist: 0.500,
            hip: 0.390, knee: 0.230, ankle: 0.090,
            limbX: 0.130, elbowX: 0.200, handX: 0.290, legX: 0.070 };
const HEIGHT = 1.74;                                    // CONFIG.CHARACTER.height
const TARGET = (function () {
  const out = { torso: { parent: null, pos: [0, J.hip * HEIGHT] },
                head: { parent: 'torso', pos: [0, J.neck * HEIGHT] } };
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    out['shoulder' + side] = { parent: 'torso', pos: [s * J.limbX * HEIGHT, J.shoulder * HEIGHT] };
    out['elbow' + side] = { parent: 'shoulder' + side, pos: [s * J.elbowX * HEIGHT, J.elbow * HEIGHT] };
    out['hand' + side] = { parent: 'elbow' + side, pos: [s * J.handX * HEIGHT, J.wrist * HEIGHT] };
    out['hip' + side] = { parent: 'torso', pos: [s * J.legX * HEIGHT, J.hip * HEIGHT] };
    out['knee' + side] = { parent: 'hip' + side, pos: [s * J.legX * HEIGHT, J.knee * HEIGHT] };
    out['foot' + side] = { parent: 'knee' + side, pos: [s * J.legX * HEIGHT, J.ankle * HEIGHT] };
  }
  return out;
})();

const TICKS = 46186158000;                             // FBX KTime ticks per second
const cleanName = s => String(s).split('\u0000')[0].replace(/^.*::/, '');
function toF64(a) {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Number(a[i]);
  return out;
}

/* the named P record of a <Properties70> box, as numbers (or null) */
function p70(node, key) {
  const box = (node.children || []).find(c => c.name === 'Properties70');
  if (!box) return null;
  for (const p of box.children) {
    if (p.name !== 'P' || p.props[0] !== key) continue;
    const rest = p.props.slice(4);
    return rest.length === 1 ? rest[0] : rest;
  }
  return null;
}
function sample(curve, t) {
  const times = curve.times, vals = curve.values;
  if (!times.length) return 0;
  if (t <= times[0]) return vals[0];
  const last = times.length - 1;
  if (t >= times[last]) return vals[last];
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  const span = (times[hi] - times[lo]) || 1;
  return vals[lo] + (vals[hi] - vals[lo]) * ((t - times[lo]) / span);
}

/* Reads a Mixamo FBX: the skeleton's rest pose, its hierarchy, every animated
   channel, and the clip's length in seconds. */
function readClip(file) {
  const fbx = R.read(fs.readFileSync(file));
  const objects = R.find(fbx, 'Objects')[0];
  const conns = [];
  for (const n of R.find(fbx, 'Connections')) {
    for (const c of n.children) if (c.name === 'C') conns.push(c.props);
  }
  const byId = new Map();
  for (const o of objects.children) {
    if (o.name !== 'Model') continue;
    byId.set(o.props[0], {
      id: o.props[0], name: cleanName(o.props[1]), parent: null, children: [],
      t: p70(o, 'Lcl Translation') || [0, 0, 0],
      r: p70(o, 'Lcl Rotation') || [0, 0, 0],
      pre: p70(o, 'PreRotation') || [0, 0, 0],
      rotOrder: p70(o, 'RotationOrder') || 0,
      inherit: p70(o, 'InheritType') || 0
    });
  }
  for (const c of conns) {
    if (c[0] !== 'OO') continue;
    const child = byId.get(c[1]), parent = byId.get(c[2]);
    if (child && parent) { child.parent = parent.name; parent.children.push(child.id); }
  }
  const bones = new Map();
  for (const m of byId.values()) bones.set(m.name, m);
  /* an "OP" link joins a curve node to the model+property it drives, and a
     curve to its curve node+axis, so both ends live in the same list */
  const chanOwner = new Map(), curveRel = new Map();
  for (const c of conns) {
    if (c[0] !== 'OP' || typeof c[3] !== 'string') continue;
    if (c[3].indexOf('d|') === 0) curveRel.set(c[1], { node: c[2], axis: c[3].slice(2) });
    else chanOwner.set(c[1], { model: c[2], prop: c[3] });
  }
  const channels = new Map();                          // bone -> prop -> axis -> curve
  let keys = 0;
  for (const o of objects.children) {
    if (o.name !== 'AnimationCurve') continue;
    const rel = curveRel.get(o.props[0]);
    const own = rel && chanOwner.get(rel.node);
    const bone = own && byId.get(own.model);
    if (!bone) continue;
    const kt = R.find(o, 'KeyTime')[0], kv = R.find(o, 'KeyValueFloat')[0];
    if (!kt || !kv || !kt.props[0] || !kv.props[0]) continue;
    const ticks = kt.props[0];
    const times = new Float64Array(ticks.length);
    for (let i = 0; i < ticks.length; i++) times[i] = Number(ticks[i]) / TICKS;
    const props = channels.get(bone.name) || {};
    props[own.prop] = props[own.prop] || {};
    props[own.prop][rel.axis] = { times, values: toF64(kv.props[0]) };
    channels.set(bone.name, props);
    keys = Math.max(keys, ticks.length);
  }
  let duration = 0;
  for (const o of objects.children) {
    if (o.name !== 'AnimationStack') continue;
    const stop = p70(o, 'LocalStop');
    if (typeof stop === 'number' && stop > 0) duration = Math.max(duration, stop / TICKS);
  }
  for (const props of channels.values()) {
    for (const axes of Object.values(props)) {
      for (const cur of Object.values(axes)) {
        if (cur.times.length) duration = Math.max(duration, cur.times[cur.times.length - 1]);
      }
    }
  }
  const order = [];
  const rootIds = [...byId.keys()].filter(id => !byId.get(id).parent);
  (function walk(ids) {
    for (const id of ids) { order.push(byId.get(id).name); walk(byId.get(id).children); }
  })(rootIds);
  return { file, name: path.basename(file), order, roots: rootIds.map(id => byId.get(id).name),
           bones, channels, duration, keys };
}

/* ---- local/world transforms at a moment in time ---- */
/* FBX composes a node's rotation as PreRotation * Euler(x,y,z), so the Euler
   channels a clip animates simply replace the rest euler inside that product. */
function localRot(clip, bone, t) {
  const chan = clip.channels.get(bone.name);
  const c = chan && chan['Lcl Rotation'];
  const order = EULER_ORDER[bone.rotOrder] || 'ZYX';
  let rx = bone.r[0], ry = bone.r[1], rz = bone.r[2];
  if (c && t !== null) {
    if (c.X) rx = sample(c.X, t);
    if (c.Y) ry = sample(c.Y, t);
    if (c.Z) rz = sample(c.Z, t);
  }
  return qToMat3(qMul(qFromEuler(bone.pre[0] * D2R, bone.pre[1] * D2R, bone.pre[2] * D2R, order),
                      qFromEuler(rx * D2R, ry * D2R, rz * D2R, order)));
}
function localPos(clip, bone, t) {
  const chan = clip.channels.get(bone.name);
  const c = chan && chan['Lcl Translation'];
  if (!c || t === null) return [bone.t[0], bone.t[1], bone.t[2]];
  return [c.X ? sample(c.X, t) : bone.t[0],
          c.Y ? sample(c.Y, t) : bone.t[1],
          c.Z ? sample(c.Z, t) : bone.t[2]];
}
/* world rotation and position of every bone; t === null means the rest pose */
function fk(clip, t) {
  const rot = new Map(), pos = new Map();
  for (const name of clip.order) {
    const bone = clip.bones.get(name);
    const lr = localRot(clip, bone, t);
    if (!bone.parent) {
      rot.set(name, lr);
      pos.set(name, localPos(clip, bone, t));
      continue;
    }
    const pr = rot.get(bone.parent), pp = pos.get(bone.parent);
    const w = mApply(pr, localPos(clip, bone, t));
    rot.set(name, mMul(pr, lr));
    pos.set(name, [pp[0] + w[0], pp[1] + w[1], pp[2] + w[2]]);
  }
  return { rot, pos };
}
const r3 = v => '[' + v.map(n => (+n).toFixed(3)).join(', ') + ']';
/* Mixamo prefixes every bone ("mixamorig:Hips", "mixamorigHips", ...), so the
   map above is written with bare names and resolved here. */
const shortName = n => String(n).replace(/^mixamorig[:_]?/, '');
function resolveBone(clip, short) {
  if (clip.bones.has(short)) return clip.bones.get(short);
  for (const b of clip.bones.values()) if (shortName(b.name) === short) return b;
  return null;
}
const HIPS = clip => resolveBone(clip, 'Hips');


/* ---------- report: what a clip contains, in human terms ---------- */
function report(clip) {
  console.log('=== ' + clip.file + ' ===');
  console.log('  ' + clip.bones.size + ' bones, root ' + JSON.stringify(clip.roots) +
    ', ' + clip.duration.toFixed(4) + ' s, up to ' + clip.keys + ' keys (' +
    (clip.keys / clip.duration).toFixed(2) + ' Hz)');
  const orders = new Set(), inherits = new Set();
  for (const b of clip.bones.values()) { orders.add(b.rotOrder); inherits.add(b.inherit); }
  console.log('  rotation orders ' + [...orders].join('/') + ' (0 = XYZ), inherit types ' + [...inherits].join('/'));

  let animated = 0;
  const perBone = [];
  for (const [name, props] of clip.channels) {
    const channels = [];
    for (const [prop, axes] of Object.entries(props)) {
      for (const [axis, cur] of Object.entries(axes)) {
        channels.push(prop.replace('Lcl ', '') + '.' + axis + '(' + cur.times.length + ')');
      }
    }
    animated++;
    perBone.push('  ' + name + ': ' + channels.join(' '));
  }
  console.log('  animated bones ' + animated + ' of ' + clip.bones.size);
  perBone.forEach(l => console.log(l));

  const rest = fk(clip, null);
  console.log('  --- rest pose (world, FBX cm, Y up) ---');
  const want = new Set(['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End',
    'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightHand',
    'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot',
    'LeftToeBase', 'RightToeBase']);
  for (const name of clip.order) {
    const short = shortName(name);
    if (want.has(short)) console.log('    ' + short.padEnd(14) + ' ' + r3(rest.pos.get(name)));
  }
  /* the clip's own motion: where the hips travel over the cycle */
  const frames = 12;
  const hips = HIPS(clip).name;
  let minY = Infinity, maxY = -Infinity;
  const hipsRow = [];
  for (let i = 0; i <= frames; i++) {
    const t = clip.duration * i / frames;
    const w = fk(clip, t);
    const p = w.pos.get(hips);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    if (i % 3 === 0) hipsRow.push(t.toFixed(2) + ':' + p[1].toFixed(1) + '/' + p[2].toFixed(1));
  }
  console.log('  hips Y ' + minY.toFixed(2) + '..' + maxY.toFixed(2) + ' (bob ' +
    (maxY - minY).toFixed(2) + ' cm); Y/Z at ' + hipsRow.join(' '));
}

/* ---------- CLI ---------- */
const CLIPS = [{ id: 'walk', file: 'walking.fbx' },
               { id: 'run', file: 'Fast Run.fbx', trimTail: true },
               { id: 'crouchIdle', file: 'Crouch Idle.fbx' },
               { id: 'crouchWalk', file: 'Crouch Walking.fbx' },
               /* the walk with a gun in hand. Same retarget as the rest, and the
                  runtime adds a SHARE of it on top of the procedural hold pose (its
                  arm swing and its carry posture): the model keeps holding the gun
                  where it was built to and gains the real gait and arm sway of a
                  gun carry, while the clip's bladed carry posture - which the gun
                  pinned in front of his chest cannot follow - stays a hint rather
                  than the whole pose (CONFIG.CHARACTER.anims.armedArm/armedPose). */
               { id: 'walkArmed', file: 'walking_armed.fbx' }];
const ROOT = path.resolve(__dirname, '..');

/* Some exports pad the take with keys that just hold the final pose (Fast
   Run.fbx: ~0.65 s of run, then a frozen tail out to 3.33 s). `trimTail` cuts
   the clip where the last channel stops changing, so the padding never bakes
   into the cycle. */
function trimTail(clip) {
  let end = 0;
  for (const props of clip.channels.values()) {
    for (const axes of Object.values(props)) {
      for (const cur of Object.values(axes)) {
        const n = cur.values.length;
        if (!n) continue;
        const last = cur.values[n - 1];
        for (let i = n - 2; i >= 0; i--) {
          if (Math.abs(cur.values[i] - last) > 1e-4) {
            /* the hold starts at the next key - that is where motion ends */
            end = Math.max(end, cur.times[i + 1]);
            break;
          }
        }
      }
    }
  }
  if (end > 0 && end < clip.duration) {
    /* keep one frame of the hold: the bake's last sample is duration - 1/FPS,
       and the frozen pose is exactly the loop's first frame, so sampling it is
       what makes the baked cycle close with a zero joint gap */
    const cut = end + 1 / FPS;
    console.log('  ' + clip.name + ': frozen tail trimmed, ' + clip.duration.toFixed(2) +
                ' s -> ' + cut.toFixed(2) + ' s');
    clip.duration = cut;
  }
}

function main() {
  const reportOnly = process.argv.indexOf('--report') >= 0;
  for (const spec of CLIPS) {
    const full = path.join(ROOT, spec.file);
    if (!fs.existsSync(full)) throw new Error('missing ' + full);
    const clip = readClip(full);
    if (spec.trimTail) trimTail(clip);
    report(clip);
    if (!reportOnly) bake(clip, spec);
  }
  if (reportOnly) return;
  writeSidecar();
}

/* ---------- the sidecar the page loads ---------- */
function writeSidecar() {
  const ids = Object.keys(BAKED);
  const out = [];
  out.push('/* freddy_anims.js - GENERATED, do not edit.');
  out.push('   The player\'s walk, run, crouch and gun-carry cycles, retargeted from Mixamo FBX');
  out.push('   onto the hinges CharacterRig builds for Freddy (see tools/fbx-bake.js). Every');
  out.push('   is Euler XYZ in radians, one key per frame at ' + FPS + ' Hz, in the rig\'s own hinge');
  out.push('   order. `bob` is the hips\' vertical lift in metres about the cycle\'s average, and');
  out.push('   `sink` is how far the pose lifts the feet on the rig - the runtime drops the model');
  out.push('   root by it so a crouch still plants (see tools/fbx-bake.js).');
  out.push('');
  out.push('   Rebuild with:  node tools/fbx-bake.js');
  out.push('   Sources: ' + ids.map(id => BAKED[id].source).join(', ') + ' (Mixamo) */');
  out.push('window.FREDDY_ANIMS = {');
  out.push('  fps: ' + FPS + ',');
  out.push('  clips: {');
  ids.forEach((id, n) => {
    const c = BAKED[id];
    out.push('    ' + id + ': {');
    out.push('      source: ' + JSON.stringify(c.source) + ', duration: ' + c.duration +
      ', frames: ' + c.frames + ', cycleSpeed: ' + c.cycleSpeed + ', sink: ' + c.sink + ',');
    out.push('      bob: [' + c.bob.join(', ') + '],');
    out.push('      bones: {');
    const bones = Object.keys(c.bones);
    bones.forEach((b, k) => {
      const flat = c.bones[b];
      const rows = [];
      for (let i = 0; i < flat.length; i += 30) rows.push(flat.slice(i, i + 30).join(', '));
      out.push('        ' + b + ': [' + rows[0] + (rows.length > 1 ? ',' : '') );
      for (let i = 1; i < rows.length; i++) {
        out.push('          ' + rows[i] + (i === rows.length - 1 ? '' : ','));
      }
      out.push('        ]' + (k === bones.length - 1 ? '' : ','));
    });
    out.push('      }');
    out.push('    }' + (n === ids.length - 1 ? '' : ','));
  });
  out.push('  }');
  out.push('};');
  out.push('');
  const file = path.join(ROOT, 'freddy_anims.js');
  fs.writeFileSync(file, out.join('\n'), 'utf8');
  const kb = (fs.statSync(file).size / 1024).toFixed(1);
  console.log('wrote ' + file + ' (' + kb + ' KB) for ' + ids.length + ' clips');
}


/* ---------- the retarget ---------- */
const FPS = 60;                                        // baked sample rate
const BAKED = {};                                      // clip id -> output table

/* forward kinematics over a baked table on the target hinge tree - the same
   maths tools/fbx-check.js plays back with - so the bake can measure where a
   pose puts the feet on Freddy's own proportions. */
const EAXIS = {
  x: a => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)],
  y: a => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)],
  z: a => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1]
};
const eulerMat = (x, y, z) => mMul(mMul(EAXIS.x(x), EAXIS.y(y)), EAXIS.z(z));
const TARGET_ORDER = Object.keys(TARGET).sort((a, b) => {
  const depth = n => { let d = 0, p = TARGET[n].parent; while (p) { d++; p = TARGET[p].parent; } return d; };
  return depth(a) - depth(b);
});
function targetFramePos(bones, f) {
  const pos = {}, rot = {};
  for (const name of TARGET_ORDER) {
    const parent = TARGET[name].parent;
    const i = f * 3, t = bones[name];
    const r = eulerMat(t[i], t[i + 1], t[i + 2]);
    const here = [TARGET[name].pos[0], TARGET[name].pos[1], 0];
    const off = parent
      ? mApply(rot[parent], [here[0] - TARGET[parent].pos[0], here[1] - TARGET[parent].pos[1], 0])
      : here;
    rot[name] = parent ? mMul(rot[parent], r) : r;
    const base = pos[parent] || [0, 0, 0];
    pos[name] = [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
  }
  return pos;
}

/* A world-space delta: how far a bone's world rotation has moved from rest.
   Multiplying it onto the target's own rest pose is what lets a Mixamo rig
   drive Freddy's hinges without sharing its bone lengths or hierarchy. */
const worldDelta = (src, rest, name) => mMul(src.rot.get(name), mT(rest.rot.get(name)));
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function bake(clip, spec) {
  const frames = Math.max(2, Math.round(clip.duration * FPS));
  const step = clip.duration / frames;
  const hips = HIPS(clip);
  const srcRest = fk(clip, null);
  /* source centimetres -> Freddy's metres, scaled by hip height: limbs (not
     total body height) are what set a stride and a bob */
  const scale = (J.hip * HEIGHT) / srcRest.pos.get(hips.name)[1];

  const names = Object.keys(MAP);
  const src = names.map(n => resolveBone(clip, MAP[n].src));
  const parentIdx = names.map(n => {
    const p = TARGET[n].parent;
    return p ? names.indexOf(p) : -1;
  });
  const missing = names.filter((n, i) => !src[i]);
  if (missing.length) throw new Error(clip.name + ': no source bone for ' + missing.join(', '));

  const rows = [], bob = [];
  /* ---------- pass 1: the source's world orientation every frame ----------
     Averaging that gives the clip's own neutral pose for each bone, which is
     the reference the motion is measured from further down. */
  const world = [], meanAcc = names.map(() => [0, 0, 0, 0]);
  for (let f = 0; f < frames; f++) {
    const t = f * step;
    const s = fk(clip, t);
    const frame = [];
    for (let i = 0; i < names.length; i++) {
      const m = s.rot.get(src[i].name);
      let q = qNorm(mToQuat(m));
      const prev = f > 0 ? world[f - 1][i].q : null;
      /* q and -q are the same rotation: keep the track's hemisphere stable so
         the average below behaves */
      if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) {
        q = [-q[0], -q[1], -q[2], -q[3]];
      }
      frame.push({ m, q });
      for (let k = 0; k < 4; k++) meanAcc[i][k] += q[k];
    }
    world.push(frame);
    bob.push(s.pos.get(hips.name)[1]);
  }
  /* ---------- the reference each bone's motion is measured from ----------
     Normally that is the source's own rest orientation, so the target follows
     the clip's absolute pose. A bone whose rest pose is nothing like the
     target's - Mixamo's T-pose arms against Freddy's, which hang at his sides -
     is measured from the clip's *average world orientation* instead, so what
     is transferred is the swing around the middle of the clip, riding on the
     pose the model was actually built in. `neutral` mixes the two. */
  const ref = names.map((n, i) => {
    const restQ = qNorm(mToQuat(srcRest.rot.get(src[i].name)));
    const w = MAP[n].neutral;
    return qToMat3(w > 0 ? qSlerp(restQ, qNorm(meanAcc[i]), w) : restQ);
  });

  /* ---------- pass 2: what each hinge has to do ----------
     D(bone) = Rworld(bone) * ref(bone)^-1 is a world-space rotation, and the
     local rotation that makes the target's world orientation follow it is
     Rworld_target(parent)^-1 * Rworld_target(bone), with the target's own rest
     pose (identity, the rig's bones are plain groups) as the base. */
  for (let f = 0; f < frames; f++) {
    const delta = world[f].map((w, i) => mMul(w.m, mT(ref[i])));
    const row = [];
    for (let i = 0; i < names.length; i++) {
      const p = parentIdx[i];
      row.push(qNorm(mToQuat(mMul(mT(p < 0 ? IDENTITY : delta[p]), delta[i]))));
    }
    rows.push(row);
  }

  /* the baked table: Euler XYZ per hinge per frame, unwrapped so the runtime
     can interpolate straight between frames */
  const bones = {}, stats = [];
  for (let i = 0; i < names.length; i++) {
    const track = [];
    let prev = null, jump = 0;
    for (let f = 0; f < frames; f++) {
      let e = qToEulerXYZ(rows[f][i]);
      if (prev) {
        for (let k = 0; k < 3; k++) {
          while (e[k] - prev[k] > Math.PI) e[k] -= Math.PI * 2;
          while (e[k] - prev[k] < -Math.PI) e[k] += Math.PI * 2;
        }
        jump = Math.max(jump, Math.abs(e[0] - prev[0]), Math.abs(e[1] - prev[1]), Math.abs(e[2] - prev[2]));
      }
      prev = e;
      track.push(e);
    }
    const flat = [];
    for (const e of track) for (const a of e) flat.push(+a.toFixed(4));
    bones[names[i]] = flat;
    /* the per-axis swing, so the report can show a stride arrived instead of
       a frozen pose */
    const range = [0, 1, 2].map(k => {
      let lo = Infinity, hi = -Infinity;
      for (const e of track) { lo = Math.min(lo, e[k]); hi = Math.max(hi, e[k]); }
      return (hi - lo) * 180 / Math.PI;
    });
    stats.push({ bone: names[i], src: shortName(src[i].name), range, jump: jump * 180 / Math.PI });
  }
  const bobMean = bob.reduce((a, b) => a + b, 0) / bob.length;
  const bobOut = bob.map(v => +((v - bobMean) * scale).toFixed(4));
  const dz = fk(clip, clip.duration).pos.get(hips.name)[2] - fk(clip, 0).pos.get(hips.name)[2];
  const cycleSpeed = Math.abs(dz) * scale / clip.duration;

  /* the rig's hinges do not translate, so a pose the source holds by dropping
     its hips (the crouch) lifts the target's feet off the floor instead. Measure
     that lift on the baked table and export it as `sink`: the runtime drops the
     model root by it so the lower foot still plants. */
  let footMin = Infinity;
  for (let f = 0; f < frames; f++) {
    const p = targetFramePos(bones, f);
    footMin = Math.min(footMin, p.footL[1], p.footR[1]);
  }
  const sink = +Math.max(0, footMin - J.ankle * HEIGHT).toFixed(4);

  BAKED[spec.id] = {
    id: spec.id, source: clip.name, duration: +(frames * step).toFixed(4), frames,
    bones, bob: bobOut, cycleSpeed: +cycleSpeed.toFixed(3), sink
  };
  console.log('  baked ' + spec.id + ': ' + frames + ' frames @' + FPS + ' Hz, ' +
    (frames * step).toFixed(3) + ' s cycle, source root speed ' + cycleSpeed.toFixed(2) +
    ' m/s at Freddy\'s size, root sink ' + sink.toFixed(3) + ' m');
  for (const s of stats) {
    console.log('    ' + s.bone.padEnd(10) + '<- ' + s.src.padEnd(14) +
      ' swing x/y/z ' + s.range.map(v => v.toFixed(1)).join('/') + ' deg' +
      '   max step ' + s.jump.toFixed(1) + ' deg');
  }
}

/* Exposed for tools/fbx-check.js, which plays the baked tables back through the
   rig's hinge tree; running this file directly bakes and writes the sidecar. */
module.exports = { readClip, fk, bake, resolveBone, TARGET, J, HEIGHT, MAP, FPS };

if (require.main === module) main();
