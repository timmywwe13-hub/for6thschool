const fs = require('fs');
global.window = global;
require('../freddy_anims.js');
const clips = window.FREDDY_ANIMS.clips;
const names = ['torso', 'head', 'hipL', 'hipR', 'kneeL', 'kneeR', 'shoulderR', 'shoulderL'];
const axis = ['x', 'y', 'z'];
for (const cn of ['walk', 'walkArmed']) {
  const c = clips[cn];
  if (!c) { console.log(cn, 'missing'); continue; }
  console.log('--- ' + cn + '  frames ' + c.frames + '  dur ' + c.duration.toFixed(3) +
    '  sink ' + (c.sink || 0).toFixed(3));
  for (const n of names) {
    const t = c.bones[n];
    if (!t) { console.log('    ' + n.padEnd(10) + ' (no track)'); continue; }
    const out = [];
    for (let k = 0; k < 3; k++) {
      let lo = Infinity, hi = -Infinity, first = t[k], last = t[(c.frames - 1) * 3 + k];
      for (let i = 0; i < c.frames; i++) { const v = t[i * 3 + k]; if (v < lo) lo = v; if (v > hi) hi = v; }
      out.push(axis[k] + ' ' + lo.toFixed(3) + '..' + hi.toFixed(3) +
        ' (mean ' + ((lo + hi) / 2).toFixed(3) + ', ends ' + first.toFixed(3) + '/' + last.toFixed(3) + ')');
    }
    console.log('    ' + n.padEnd(10) + out.join('   '));
  }
}

