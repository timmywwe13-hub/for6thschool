// Skins scenario: the whole Locker roster loads through the Character
// pipeline - each skin reaches state ready, gets rigged (static models) or
// skeleton-driven (skinned models), normalises to player height and shows on
// the player; a missing file falls back to the humanoid; the Locker screen
// lists every skin with its name, previews the real model on the turntable
// and EQUIPs the pick into the settings, which survives a reload.
// Run it with:  node cdp-test.js skins
const lib = require('../cdp-lib');

module.exports = async function skins(ctx) {
  const { evaluate, check, sleep, send } = ctx;

  /* helper injected into the page: the state of the player's character in one
     object (which skin, the load state, the rig, the on-screen height).
     It has to be re-injected after any page reload. */
  const PROBE = `(function () {
    /* The box a model really draws, as opposed to the one Box3 reports for a
       SkinnedMesh: every vertex through the skinning chain (getVertexPosition)
       and the mesh's world matrix, with a fresh bindMatrixInverse (only
       updateMatrixWorld refreshes that one). The two differ wildly on the
       Fortnite rips - the box said 0.11 m for a model that draws 30 m tall -
       and that gap is what sized demi and aura wrongly, so the harness has to
       measure the drawn thing, not the reported one. */
    window.__drawnBox = function (node) {
      if (!node) return null;
      node.updateMatrixWorld(true);
      var v = new THREE.Vector3();
      var lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9);
      node.traverse(function (o) {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        var pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
        if (!pos) return;
        var sk = !!(o.isSkinnedMesh && o.skeleton);
        for (var i = 0; i < pos.count; i++) {
          if (sk) o.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
          v.applyMatrix4(o.matrixWorld);
          lo.min(v); hi.max(v);
        }
      });
      return { y: +(hi.y - lo.y).toFixed(3), minY: +lo.y.toFixed(3),
               x: +(hi.x - lo.x).toFixed(3), z: +(hi.z - lo.z).toFixed(3) };
    };
    window.__skinProbe = function () {
      var ch = App.scene.getObjectByName('playerCharacter');
      var holder = ch && ch.getObjectByName('playerCharacterModel');
      var rigRoot = ch && ch.getObjectByName('playerCharacterRig');
      var bones = 0, rigMeshes = 0;
      if (rigRoot) rigRoot.traverse(function (o) {
        if (o.name && o.name.indexOf('bone_') === 0) bones++;
        if (o.isMesh) rigMeshes++;
      });
      var height = 0;
      if (holder && holder.children.length) {
        var b = new THREE.Box3().setFromObject(holder);
        height = +(b.max.y - b.min.y).toFixed(2);
      }
      var prims = 0;
      if (ch) ch.traverse(function (o) { if (o.isMesh && o.visible) prims++; });
      return {
        skin: PlayerView.skin(), status: Character.state.status,
        using: PlayerView.usingModel(), skinned: Character.skinned(),
        bones: bones, rigMeshes: rigMeshes, height: height,
        primitivesShowing: !PlayerView.usingModel() && prims > 0,
        source: Character.state.source
      };
    };
    return 'ready';
  })()`;
  await evaluate(PROBE);

  /* the player height every skin is fitted to, straight from the page */
  const CONFIG_H = await evaluate(`CONFIG.CHARACTER.height`);

  async function waitSkin(id, tries) {
    let st = null;
    for (let i = 0; i < (tries || 120); i++) {
      st = JSON.parse(await evaluate(`JSON.stringify(window.__skinProbe())`));
      if (st.skin === id && (st.status === 'ready' || st.status === 'failed')) {
        if (st.status === 'failed') return st;
        if (st.using || st.primitivesShowing) return st;
      }
      await sleep(300);
    }
    return st;
  }

  /* ---------- the default boot: Freddy ---------- */
  const boot = await waitSkin('freddy');
  console.log('  boot: ' + JSON.stringify(boot));
  check('the default skin (Freddy) loads and shows on the player',
    boot.status === 'ready' && boot.using && boot.skin === 'freddy',
    boot.status + ' / ' + boot.skin);

  /* ---------- the Locker screen ---------- */
  await evaluate(`document.getElementById('btnLocker').click(); 'go'`);
  await sleep(400);
  const lk0 = JSON.parse(await evaluate(`JSON.stringify(Locker.state())`));
  console.log('  locker: ' + JSON.stringify(lk0));
  check('the locker opens with one named chip per roster skin',
    lk0.open && lk0.chips === 6 &&
    lk0.chipNames.indexOf('Freddy Fazbear') !== -1 && lk0.chipNames.indexOf('Aura') !== -1,
    lk0.chips + ' chips: ' + lk0.chipNames.join(', '));

  /* the selected skin previews as the real rotating 3D model */
  let lk = lk0;
  for (let i = 0; i < 60; i++) {
    lk = JSON.parse(await evaluate(`JSON.stringify(Locker.state())`));
    if (lk.previewId === 'freddy' && lk.previewMeshes > 0) break;
    await sleep(300);
  }
  check('the turntable preview is the real 3D model',
    lk.gl && lk.previewId === 'freddy' && lk.previewMeshes >= 6,
    'previewing ' + lk.previewId + ', meshes ' + lk.previewMeshes + ', gl ' + lk.gl);

  /* picking another chip swaps the preview; EQUIP wires the settings */
  await evaluate(`document.querySelector('#skinChips [data-skin="bonnie"]').click(); 'go'`);
  for (let i = 0; i < 80; i++) {
    lk = JSON.parse(await evaluate(`JSON.stringify(Locker.state())`));
    if (lk.previewId === 'bonnie' && lk.previewMeshes > 0) break;
    await sleep(300);
  }
  check('clicking a chip swaps the rotating preview',
    lk.selected === 'bonnie' && lk.previewId === 'bonnie' && lk.previewMeshes >= 7,
    'selected ' + lk.selected + ', previewing ' + lk.previewId + ', meshes ' + lk.previewMeshes);
  await evaluate(`document.getElementById('btnEquipSkin').click(); 'go'`);
  await sleep(200);
  check('EQUIP writes the pick into the settings',
    await evaluate(`SETTINGS.skin`) === 'bonnie', await evaluate(`SETTINGS.skin`));
  const bon = await waitSkin('bonnie');
  check('the in-game model swaps live, no reload needed',
    bon.status === 'ready' && bon.using && bon.skin === 'bonnie' && bon.bones === 14,
    bon.status + ' / ' + bon.skin + ' / ' + bon.bones + ' hinges');
  await evaluate(`document.getElementById('btnLockerBack').click(); 'go'`);
  check('BACK returns to the start screen',
    await evaluate(`document.getElementById('lockerScreen').classList.contains('hidden')`), '');

  check('the static model rigged onto the 14 hinges',
    boot.bones === 14 && boot.rigMeshes > 0 && !boot.skinned,
    boot.bones + ' hinges, ' + boot.rigMeshes + ' rig meshes');
  check('normalised to player height', boot.height > 1.5 && boot.height < 2.0, boot.height + ' m');


  /* ---------- the rest of the roster on the player ---------- */
  /* ghost stays off the tail spot: the skeleton-drive probe below needs the
     last-equipped skin to be a skinned one, and ghost is a static rip */
  for (const id of ['michael', 'demi', 'ghost', 'aura']) {
    await evaluate(`PlayerView.setSkin('` + id + `'); 'go'`);
    const st = await waitSkin(id, 200);
    console.log('  ' + id + ': ' + JSON.stringify(st));
    check(id + ' loads and shows on the player',
      st && st.status === 'ready' && st.using && st.skin === id,
      st ? (st.status + ' / ' + st.skin) : 'timeout');
    check(id + ' normalises to player height',
      st && st.height > 1.5 && st.height < 2.0, st ? (st.height + ' m') : '-');
    if (id === 'michael' || id === 'ghost') {
      check(id + ' is static and rigged through the piece cutter',
        st && !st.skinned && st.rigMeshes > 0 && st.bones === 14,
        st ? (st.rigMeshes + ' rig meshes, ' + st.bones + ' hinges') : '-');
    } else {
      check(id + ' is skinned and its skeleton is driven',
        st && st.skinned && st.bones === 14,
        st ? (st.bones + ' hinges driving the skeleton') : '-');
    }
  }

  /* ---------- every skin draws at Freddy's size ----------
     The check the roster exists for. `height` above is the number the loader
     scaled the model to; this is the size it actually draws at, and every skin
     - skinned rips included - has to land within 5% of the player height with
     its soles on the floor and no axis ballooning out. Demi used to draw 4.2x
     Freddy's height here and Aura a speck. */
  const sizes = {};
  for (const id of ['freddy', 'bonnie', 'michael', 'ghost', 'demi', 'aura']) {
    await evaluate(`PlayerView.setSkin('` + id + `'); 'go'`);
    const st = await waitSkin(id, 200);
    sizes[id] = await evaluate(`JSON.stringify(window.__drawnBox(
      App.scene.getObjectByName('playerCharacterModel')))`);
    sizes[id] = sizes[id] ? JSON.parse(sizes[id]) : null;
    console.log('  drawn ' + id + ': ' + JSON.stringify(sizes[id]));
    check(id + ' draws ' + CONFIG_H + ' m tall, soles on the floor',
      !!sizes[id] && st && st.status === 'ready' &&
      Math.abs(sizes[id].y - CONFIG_H) < CONFIG_H * 0.05 && Math.abs(sizes[id].minY) < 0.06,
      sizes[id] ? (sizes[id].y + ' m, soles ' + sizes[id].minY) : 'no model');
    check(id + ' is not stretched out of shape',
      !!sizes[id] && sizes[id].x < 1.6 && sizes[id].z < 1.6,
      sizes[id] ? (sizes[id].x + ' x ' + sizes[id].z + ' m wide/deep') : 'no model');
  }
  const base = sizes.freddy ? sizes.freddy.y : 0;
  const off = Object.keys(sizes).filter(id => sizes[id] &&
    Math.abs(sizes[id].y - base) > base * 0.05);
  check('every skin on the roster is Freddy\'s height within 5%',
    !!base && off.length === 0,
    'freddy ' + base + ' m; off: ' + (off.length ? off.join(', ') : 'none'));

  /* the skinned skeleton plays the same baked cycle: a thigh bone's local
     rotation must follow the walk */
  const drive = JSON.parse(await evaluate(`(function () {
    var holder = App.scene.getObjectByName('playerCharacterModel');
    var bone = null;
    holder.traverse(function (o) { if (!bone && o.isBone && /thigh_l/i.test(o.name || '')) bone = o; });
    if (!bone) return JSON.stringify({ bone: false });
    Input.keys = Object.create(null);
    Player.vel.set(0, 0, -5.7);
    var q0 = bone.quaternion.toArray();
    for (var i = 0; i < 30; i++) PlayerView.update(1 / 60, Player);
    var q1 = bone.quaternion.toArray();
    for (var i = 0; i < 30; i++) PlayerView.update(1 / 60, Player);
    var q2 = bone.quaternion.toArray();
    /* read the clip weight while he is still walking - it decays the moment
       the speed drops */
    var weight = PlayerView.loco() ? +PlayerView.loco().weight.toFixed(2) : -1;
    Player.vel.set(0, 0, 0);
    for (var i = 0; i < 30; i++) PlayerView.update(1 / 60, Player);
    function d(a, b) { var s = 0; for (var k = 0; k < 4; k++) s += Math.abs(a[k] - b[k]); return +s.toFixed(3); }
    return JSON.stringify({ bone: true, moved01: d(q0, q1), moved12: d(q1, q2), weight: weight });
  })()`));
  console.log('  skeleton drive: ' + JSON.stringify(drive));
  check('the skinned skeleton plays the same baked walk cycle',
    drive.bone && drive.weight > 0.9 && drive.moved01 > 0.005 && drive.moved12 > 0.005,
    JSON.stringify(drive));

  /* ---------- the Ghost skin plays the new Fast Run cycle ----------
     ghost is a static rip, so its hinges are the piece-cutter's bone_ groups;
     sprint speed (past anims.runFull) must cross-fade the run clip fully in
     and swing a leg hinge. The clip table itself is checked too: 32 frames
     means the trimmed Fast Run bake is the one the page loaded. */
  await evaluate(`PlayerView.setSkin('ghost'); 'go'`);
  const gst = await waitSkin('ghost', 200);
  check('ghost is back on the player for the run test',
    gst && gst.status === 'ready' && gst.using, gst ? gst.status : 'timeout');
  const run = JSON.parse(await evaluate(`(function () {
    var rig = App.scene.getObjectByName('playerCharacterRig');
    var hip = rig && rig.getObjectByName('bone_hipL');
    if (!hip) return JSON.stringify({ hinge: false });
    Input.keys = Object.create(null);
    Player.vel.set(0, 0, -8.6);
    for (var i = 0; i < 60; i++) PlayerView.update(1 / 60, Player);
    var q0 = hip.quaternion.toArray();
    for (var i = 0; i < 12; i++) PlayerView.update(1 / 60, Player);
    var q1 = hip.quaternion.toArray();
    for (var i = 0; i < 12; i++) PlayerView.update(1 / 60, Player);
    var q2 = hip.quaternion.toArray();
    var loco = PlayerView.loco();
    var state = { weight: +loco.weight.toFixed(2), run: +loco.run.toFixed(2),
                  frames: CharacterRig.clips() ? CharacterRig.clips().run.frames : -1 };
    Player.vel.set(0, 0, 0);
    for (var i = 0; i < 30; i++) PlayerView.update(1 / 60, Player);
    function d(a, b) { var s = 0; for (var k = 0; k < 4; k++) s += Math.abs(a[k] - b[k]); return +s.toFixed(3); }
    return JSON.stringify({ hinge: true, moved01: d(q0, q1), moved12: d(q1, q2),
                            weight: state.weight, run: state.run, frames: state.frames });
  })()`));
  console.log('  ghost sprint drive: ' + JSON.stringify(run));
  check('the loaded run clip is the trimmed Fast Run bake',
    run.frames === 32, run.frames + ' frames');
  check('sprint speed takes the run cycle fully over on ghost',
    run.hinge && run.weight > 0.9 && run.run > 0.9,
    'weight ' + run.weight + ', run mix ' + run.run);
  check('the run cycle swings ghost\'s hip hinge',
    run.hinge && run.moved01 > 0.005 && run.moved12 > 0.005,
    JSON.stringify(run));

  /* ---------- a missing file falls back to the humanoid ---------- */
  await evaluate(`(function () {
    /* the missing-model path warns loudly by design; swallow it here so the
       harness can judge the fallback itself */
    window.__keepWarn = console.warn;
    window.__warned = [];
    console.warn = function () { window.__warned.push(Array.prototype.join.call(arguments, ' ')); };
    CONFIG.SKINS.push({ id: 'missing', name: 'Missing', credit: '- test skin',
      file: 'missing.glb', base64File: 'missing.glb.js', base64Global: 'MISSING_GLB_B64' });
    PlayerView.setSkin('missing');
    return 'go';
  })()`);
  const missing = await waitSkin('missing', 60);
  console.log('  missing: ' + JSON.stringify(missing));
  const warned = await evaluate(`(window.__warned || []).length`);
  await evaluate(`console.warn = window.__keepWarn; 'ok'`);
  check('a skin whose file is missing is reported and never shows',
    missing.status === 'failed' && !missing.using && warned > 0,
    missing.status + ', warns ' + warned);
  check('the primitive humanoid stays the fallback body', missing.primitivesShowing,
    'primitives visible: ' + missing.primitivesShowing);

  /* back to a real skin before the reload test */
  await evaluate(`PlayerView.setSkin('bonnie'); 'go'`);
  await waitSkin('bonnie');

  /* ---------- the pick persists across a reload ---------- */
  await evaluate(`SETTINGS.skin = 'bonnie'; Profile.save(); 'saved'`);
  await send('Page.navigate', { url: lib.fileUrl });
  let reloaded = null;
  for (let i = 0; i < 80; i++) {
    try {
      reloaded = await evaluate(`(function () {
        try {
          return { up: typeof App !== 'undefined' && App.state === 'MENU' &&
                        document.getElementById('bootLoading').classList.contains('hidden'),
                   skin: (typeof SETTINGS !== 'undefined') ? SETTINGS.skin : null };
        } catch (e) { return null; }
      })()`);
    } catch (e) { reloaded = null; }
    if (reloaded && reloaded.up) break;
    await sleep(500);
  }
  check('the skin pick survives a reload',
    reloaded && reloaded.up && reloaded.skin === 'bonnie', JSON.stringify(reloaded));
  await evaluate(PROBE);            // the reload wiped the injected helper
  const after = await waitSkin('bonnie', 120);
  check('the persisted skin is the one on the player after the reload',
    after.status === 'ready' && after.skin === 'bonnie' && after.using,
    after.status + ' / ' + after.skin);
};
