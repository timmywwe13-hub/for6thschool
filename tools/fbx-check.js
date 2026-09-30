// =====================================================================
// Plays the generated freddy_anims.js back through the rig's own hinge tree
// and reports where the hands, feet and head actually travel.
//
// Why: the bake is a retarget between two very different skeletons, so the
// numbers in the sidecar are hard to judge on their own. This is the fast
// offline sanity pass - it catches a knee that folds the wrong way, a foot
// that walks through the floor, an arm that swings into the chest and a cycle
// that does not close - without booting the game.
//
// Usage:  node tools/fbx-check.js          (after: node tools/fbx-bake.js)
// =====================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('./fbx-bake');

const file = path.join(__dirname, '..', 'freddy_anims.js');
if (!fs.existsSync(file)) {
  console.error('no freddy_anims.js yet - generate it with: node tools/fbx-bake.js');
  process.exit(2);
}
global.window = {};
require(file);
const ANIMS = global.window.FREDDY_ANIMS;
if (!ANIMS || !ANIMS.clips) {
  console.error('freddy_anims.js does not define window.FREDDY_ANIMS');
  process.exit(2);
}

/* ---- forward kinematics over the hinge tree (three.js XYZ Euler order) ---- */
const mul = (a, b) => {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return o;
};
const apply = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
                         m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
                         m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const AXIS = {
  x: a => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)],
  y: a => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)],
  z: a => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1]
};
const eulerXYZ = (x, y, z) => mul(mul(AXIS.x(x), AXIS.y(y)), AXIS.z(z));

/* the hinges, parents first so one pass can walk the tree */
const ORDER = Object.keys(B.TARGET).sort((a, b) => {
  const depth = n => { let d = 0, p = B.TARGET[n].parent; while (p) { d++; p = B.TARGET[p].parent; } return d; };
  return depth(a) - depth(b);
});
function framePos(clip, f) {
  const pos = {}, rot = {};
  for (const name of ORDER) {
    const parent = B.TARGET[name].parent;
    const i = (f % clip.frames) * 3;
    const r = eulerXYZ(clip.bones[name][i], clip.bones[name][i + 1], clip.bones[name][i + 2]);
    const here = [B.TARGET[name].pos[0], B.TARGET[name].pos[1], 0];
    const off = parent
      ? apply(rot[parent], [here[0] - B.TARGET[parent].pos[0], here[1] - B.TARGET[parent].pos[1], 0])
      : here;
    rot[name] = parent ? mul(rot[parent], r) : r;
    const base = pos[parent] || [0, 0, 0];
    pos[name] = [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
  }
  return pos;
}
  const span = a => Math.max.apply(null, a) - Math.min.apply(null, a);
  const r3 = v => '[' + v.map(n => (+n).toFixed(3)).join(', ') + ']';
  /* correlation coefficient - used to check the gait really is a gait: the arms
     have to swing against the same-side leg, not with it */
  function corr(a, b) {
    const n = a.length;
    const ma = a.reduce((x, y) => x + y, 0) / n;
    const mb = b.reduce((x, y) => x + y, 0) / n;
    let s = 0, sa = 0, sb = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - ma, db = b[i] - mb;
      s += da * db; sa += da * da; sb += db * db;
    }
    return s / Math.sqrt(sa * sb || 1);
  }
const PROBLEMS = [];
function check(name, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail === undefined ? '' : '   [' + detail + ']'));
  if (!ok) PROBLEMS.push(name);
}

/* ---- one clip ---- */
/* gaits get the stride checks; a held pose (the crouch idle) is judged on
   holding still with the knees folded instead */
const KIND = { walk: 'gait', run: 'gait', crouchWalk: 'gait', crouchIdle: 'pose' };
console.log('freddy_anims.js: ' + Object.keys(ANIMS.clips).join(', ') + ' at ' + ANIMS.fps + ' Hz');
for (const id of Object.keys(ANIMS.clips)) {
  const clip = ANIMS.clips[id];
  const kind = KIND[id] || 'gait';
  const sink = clip.sink || 0;
  const limb = {};
  let kneeMin = Infinity, hipSwing = 0;
  const track = { hipL: [], kneeL: [], kneeR: [], handL: [], handR: [] };
  for (let f = 0; f < clip.frames; f++) {
    const p = framePos(clip, f);
    for (const key of ['handL', 'handR', 'footL', 'footR', 'head']) {
      limb[key] = limb[key] || { x: [], y: [], z: [] };
      limb[key].x.push(p[key][0]); limb[key].y.push(p[key][1]); limb[key].z.push(p[key][2]);
    }
    const i = f * 3;
    track.hipL.push(clip.bones.hipL[i]);
    track.kneeL.push(clip.bones.kneeL[i]);
    track.kneeR.push(clip.bones.kneeR[i]);
    track.handL.push(p.handL[0]);
    track.handR.push(p.handR[0]);
    kneeMin = Math.min(kneeMin, clip.bones.kneeL[i], clip.bones.kneeR[i]);
  }
  hipSwing = span(track.hipL);
  console.log('\n--- ' + id + ' (' + clip.frames + ' frames, ' + clip.duration + ' s, source ' +
    clip.source + ') ---');
  for (const key of Object.keys(limb)) {
    console.log('  ' + key.padEnd(6) + ' x ' + r3([Math.min.apply(null, limb[key].x), Math.max.apply(null, limb[key].x)]) +
      '  y ' + r3([Math.min.apply(null, limb[key].y), Math.max.apply(null, limb[key].y)]) +
      '  z ' + r3([Math.min.apply(null, limb[key].z), Math.max.apply(null, limb[key].z)]));
  }
  if (kind === 'gait') {
    check('the leg swings (hip range > 0.5 rad)', hipSwing > 0.5, hipSwing.toFixed(3) + ' rad');
    const gaitSame = corr(limb.handL.z, limb.footL.z);
    const gaitCross = corr(limb.handL.z, limb.footR.z);
    /* a crouched gait barely swings the arms, so it is enough that they do not
       swing WITH the same-side leg and lean against the opposite one */
    const loose = id === 'crouchWalk';
    check('it is a walk, not a pace: the arm swings against the same-side leg',
      loose ? (gaitCross > 0.2 && gaitSame < 0.35) : (gaitSame < -0.25 && gaitCross > 0.25),
      'hand L vs foot L ' + gaitSame.toFixed(2) + ', vs foot R ' + gaitCross.toFixed(2));
    check('the hands never cross the body',
      Math.min.apply(null, track.handL) < -0.2 && Math.max.apply(null, track.handL) < 0 &&
      Math.max.apply(null, track.handR) > 0.2 && Math.min.apply(null, track.handR) > 0,
      'L ' + r3([Math.min.apply(null, track.handL), Math.max.apply(null, track.handL)]) +
      ' R ' + r3([Math.min.apply(null, track.handR), Math.max.apply(null, track.handR)]));
  } else {
    check('it holds a pose (the legs do not stride)', hipSwing < 0.3, hipSwing.toFixed(3) + ' rad');
    check('the crouch really folds the knees', kneeMin > 1.0, 'minimum ' + kneeMin.toFixed(3) + ' rad');
  }
  check('the knee only folds backwards', kneeMin >= 0, 'minimum ' + kneeMin.toFixed(3) + ' rad');
  /* the runtime drops the model root by clip.sink, so judge the feet where
     they actually land */
  const feet = limb.footL.y.concat(limb.footR.y).map(y => y - sink);
  check('the feet stay between the floor and a raised stride',
    Math.min.apply(null, feet) > 0.05 && Math.max.apply(null, feet) < 0.6,
    r3([Math.min.apply(null, feet), Math.max.apply(null, feet)]) + ' m (root sink ' + sink.toFixed(3) + ')');
  check('the bounce is a bounce, not a pogo', span(clip.bob) < 0.15,
    span(clip.bob).toFixed(3) + ' m peak to peak');
  let loop = 0;
  for (const bone of Object.keys(clip.bones)) {
    const t = clip.bones[bone];
    for (let k = 0; k < 3; k++) loop = Math.max(loop, Math.abs(t[k] - t[t.length - 3 + k]));
  }
  check('the cycle closes (first frame meets last)', loop < 0.25,
    'worst joint gap ' + loop.toFixed(3) + ' rad');
}

console.log('\n' + (PROBLEMS.length ? 'FAILED: ' + PROBLEMS.join('; ')
                                    : 'the baked cycles look right on the rig'));
process.exit(PROBLEMS.length ? 1 : 0);
