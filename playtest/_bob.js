global.window = global;
require('../freddy_anims.js');
const c = window.FREDDY_ANIMS.clips;
for (const n of ['walk', 'run', 'walkArmed']) {
  const cl = c[n];
  if (!cl) continue;
  const b = cl.bob;
  const mean = b.reduce((a, v) => a + v, 0) / b.length;
  console.log(n.padEnd(10) + ' frames ' + cl.frames + '  bob n=' + b.length +
    '  min ' + Math.min(...b).toFixed(4) + '  max ' + Math.max(...b).toFixed(4) +
    '  mean ' + mean.toFixed(4) + '  sink ' + (cl.sink || 0).toFixed(4));
}
