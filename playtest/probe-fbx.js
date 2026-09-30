// Scratch probe: read a list of FBX files and print what each contains that the
// bake cares about - version, creator, clip length (from the animation stack),
// bone count and whether the arms are animated. Used to check a candidate clip
// before adding it to CLIPS in tools/fbx-bake.js.
//
//   node playtest/probe-fbx.js <file.fbx> [...]
const fs = require('fs');
const R = require('../tools/fbx-read');

for (const file of process.argv.slice(2)) {
  try {
    const fbx = R.read(fs.readFileSync(file));
    const models = R.find(fbx, 'Model').filter(n => /^(Limb|LimbNode|Mesh|Null)$/.test(n.props[3] || ''));
    const anims = R.find(fbx, 'AnimationStack');
    let stop = null;
    for (const a of anims) {
      const p = R.props(a, 'Properties70') || [];
      for (const q of p) {
        if (q.name === 'P' && q.props[0] === 'LocalStop') stop = q.props[4];
      }
    }
    const curves = R.find(fbx, 'AnimationCurveNode');
    const armCurves = curves.filter(c => /Arm|Hand/.test(String(c.props[1] || '')));
    console.log(file);
    console.log('  FBX ' + fbx.version + ', creator ' + JSON.stringify(fbx.creator) +
      ', models ' + models.length + ', curves ' + curves.length +
      ' (arm/hand ' + armCurves.length + ')');
    console.log('  length ' + (stop === null ? '?' : (+stop).toFixed(2) + ' s') +
      ', stacks ' + anims.length);
    const names = models.map(m => String(m.props[1] || '').replace(/^.*::/, ''));
    console.log('  bones: ' + names.slice(0, 8).join(', ') + (names.length > 8 ? ' ...' : ''));
  } catch (e) {
    console.log(file);
    console.log('  UNREADABLE: ' + e.message);
  }
}
