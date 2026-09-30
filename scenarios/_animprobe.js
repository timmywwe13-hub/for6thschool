// Throwaway diagnostic for the baked locomotion: which rigid piece of the model
// is hung on which hinge (a mouth piece riding a foot hinge is the classic
// symptom), how much each hinge really swings, and what the walk looks like.
// Run with:  node cdp-test.js _animprobe
const fs = require('fs');
const path = require('path');

module.exports = async function animprobe(ctx) {
  const { evaluate, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('  shot ' + name);
  }

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1500);

  /* freeze the world: no bots, no damage, and a studio camera that can be
     pinned to any side of the character */
  await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < 600 && App.state === 'DROP'; i++) Game.update(0.2);
    Bots.update = function () {
      entityGrid.clear();
      if (Player.alive) entityGrid.insert(Player.pos.x, Player.pos.z, Player);
      for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) entityGrid.insert(BOTS[i].pos.x, BOTS[i].pos.z, BOTS[i]);
      BotView.flush();
    };
    window.__keepAlive = setInterval(function () {
      Player.hp = CONFIG.MAX_HP; Player.shield = 0;
      var g = World.heightAt(Player.pos.x, Player.pos.z);
      if (Player.pos.y < g) Player.pos.y = g;
    }, 100);
    window.__origGameRender = Game.render;
    window.__studioMode = '';
    window.__studioDist = 3.0;
    window.__studioY = 1.1;
    window.__studioPitch = 0.0;
    Game.render = function (dt) {
      window.__origGameRender.call(Game, dt);
      var m = window.__studioMode;
      if (!m) return;
      var cam = App.camera;
      var f = new THREE.Vector3(Math.sin(Player.yaw), 0, -Math.cos(Player.yaw));
      var r = new THREE.Vector3(-f.z, 0, f.x);
      var p = new THREE.Vector3().copy(Player.pos);
      var d = window.__studioDist;
      if (m === 'front') p.addScaledVector(f, d);
      else if (m === 'back') p.addScaledVector(f, -d);
      else if (m === 'left') p.addScaledVector(r, -d);
      else p.addScaledVector(r, d);
      p.y += window.__studioY;
      cam.position.copy(p);
      cam.lookAt(Player.pos.x, Player.pos.y + window.__studioPitch, Player.pos.z);
      App.renderer.render(App.scene, cam);
    };
    window.__studio = function (m, d, y, pitch) {
      window.__studioMode = m || '';
      if (d !== undefined) window.__studioDist = d;
      if (y !== undefined) window.__studioY = y;
      if (pitch !== undefined) window.__studioPitch = pitch;
      return window.__studioMode || 'off';
    };
    Player.yaw = 0; CAM.yaw = 0; CAM.pitch = -0.02; CAM.sync();
    Player.vel.set(0, 0, 0);
    return App.state;
  })()`);
  await sleep(600);

  /* ---------- what hangs on which hinge ---------- */
  const parts = await evaluate(`(function () {
    var ch = App.scene.getObjectByName('playerCharacter');
    var root = ch.getObjectByName('playerCharacterRig');
    if (!root) return { err: 'no rig' };
    var out = {};
    root.traverse(function (o) {
      if (!o.isMesh) return;
      var bone = o.parent && o.parent.name ? o.parent.name.replace('bone_', '') : '?';
      o.geometry.computeBoundingBox();
      var b = o.geometry.boundingBox;
      /* the geometry is authored in rig space, so the box needs no transform */
      var row = out[bone] || (out[bone] = { meshes: 0, tris: 0, lo: [9, 9, 9], hi: [-9, -9, -9] });
      row.meshes++;
      row.tris += o.geometry.index ? o.geometry.index.count / 3 : 0;
      row.lo = [Math.min(row.lo[0], b.min.x), Math.min(row.lo[1], b.min.y), Math.min(row.lo[2], b.min.z)];
      row.hi = [Math.max(row.hi[0], b.max.x), Math.max(row.hi[1], b.max.y), Math.max(row.hi[2], b.max.z)];
    });
    var brief = {};
    Object.keys(out).forEach(function (k) {
      var r = out[k];
      function t(a) { return a.map(function (v) { return +v.toFixed(2); }); }
      brief[k] = { meshes: r.meshes, tris: r.tris, lo: t(r.lo), hi: t(r.hi) };
    });
    return brief;
  })()`);
  console.log('  hinge -> geometry (rig space, metres):');
  Object.keys(parts).forEach(k => console.log('    ' + k.padEnd(11) + ' ' + JSON.stringify(parts[k])));
  const live = await evaluate(`(function () {
    var ch = App.scene.getObjectByName('playerCharacter');
    var model = ch.getObjectByName('playerCharacterModel');
    var root = ch.getObjectByName('playerCharacterRig');
    var bones = {};
    root.traverse(function (o) { if (o.name && o.name.indexOf('bone_') === 0) bones[o.name.slice(5)] = o; });
    var b = new THREE.Vector3();
    var names = ['head', 'torso', 'footL', 'footR', 'kneeL', 'kneeR', 'handL', 'handR'];
    var track = {};
    names.forEach(function (n) { track[n] = []; bones[n].rotation.set(0, 0, 0); });
    Player.vel.set(0, 0, -5.7);
    for (var i = 0; i < 120; i++) PlayerView.update(1 / 60, Player);
    for (var k = 0; k < 180; k++) {
      Player.vel.set(0, 0, -5.7);
      PlayerView.update(1 / 60, Player);
      ch.updateMatrixWorld(true);
      root.updateWorldMatrix(true, false);
      for (var i = 0; i < names.length; i++) {
        /* rig space: the character never actually travels, so this is pure limb travel */
        bones[names[i]].getWorldPosition(b);
        root.worldToLocal(b);
        track[names[i]].push([b.x, b.y, b.z]);
      }
    }
    var box = {};
    names.forEach(function (n) {
      var t = track[n], lo = [9, 9, 9], hi = [-9, -9, -9];
      for (var i = 0; i < t.length; i++) for (var k = 0; k < 3; k++) {
        if (t[i][k] < lo[k]) lo[k] = t[i][k];
        if (t[i][k] > hi[k]) hi[k] = t[i][k];
      }
      box[n] = { travel: [+(hi[0] - lo[0]).toFixed(3), +(hi[1] - lo[1]).toFixed(3), +(hi[2] - lo[2]).toFixed(3)],
                 y: [+lo[1].toFixed(3), +hi[1].toFixed(3)] };
    });
    var l = PlayerView.loco();
    return { box: box, weight: +l.weight.toFixed(2), phase: +l.phase.toFixed(2),
             bob: +l.bob.toFixed(4), modelY: +model.position.y.toFixed(3),
             headLocal: [+bones.head.rotation.x.toFixed(3), +bones.head.rotation.y.toFixed(3), +bones.head.rotation.z.toFixed(3)],
             torsoLocal: [+bones.torso.rotation.x.toFixed(3), +bones.torso.rotation.y.toFixed(3), +bones.torso.rotation.z.toFixed(3)] };
  })()`);
  console.log('  live travel over three strides (world m): ' + JSON.stringify(live));

  /* ---------- does anything integrate? ---------- */
  const wind = await evaluate(`(function () {
    var ch = App.scene.getObjectByName('playerCharacter');
    var root = ch.getObjectByName('playerCharacterRig');
    var bones = {};
    root.traverse(function (o) { if (o.name && o.name.indexOf('bone_') === 0) bones[o.name.slice(5)] = o; });
    var names = Object.keys(bones);
    var out = { at: [] };
    function snap(n) {
      var row = {};
      names.forEach(function (k) {
        var r = bones[k].rotation;
        row[k] = [+r.x.toFixed(2), +r.y.toFixed(2), +r.z.toFixed(2)];
      });
      out.at.push({ frames: n, rot: row });
    }
    names.forEach(function (k) { bones[k].rotation.set(0, 0, 0); });
    Player.vel.set(0, 0, -5.7);
    for (var i = 0; i < 60; i++) PlayerView.update(1 / 60, Player);
    snap(60);
    for (var i = 0; i < 240; i++) PlayerView.update(1 / 60, Player);
    snap(300);
    for (var i = 0; i < 600; i++) PlayerView.update(1 / 60, Player);
    snap(900);
    Player.vel.set(0, 0, 0);
    for (var i = 0; i < 300; i++) PlayerView.update(1 / 60, Player);
    snap(1200);
    return out;
  })()`);
  wind.at.forEach(s => console.log('    after ' + String(s.frames).padStart(4) + ' frames: ' + JSON.stringify(s.rot)));

  /* ---------- photographs ---------- */
  await evaluate(`Player.vel.set(0, 0, 0); 1`);
  await evaluate(`window.__studio('front', 2.6, 1.0, 0.9); 1`);
  await sleep(1200);
  await shot('_anim-idle-front');
  await evaluate(`window.__studio('left', 2.6, 1.0, 0.9); 1`);
  await sleep(900);
  await shot('_anim-idle-left');

  /* walk: keep the velocity pinned so the clip keeps running */
  await evaluate(`(function () {
    window.__spot = [Player.pos.x, World.heightAt(Player.pos.x, Player.pos.z), Player.pos.z];
    window.__pin = setInterval(function () {
      Player.vel.set(0, 0, -5.7);
      Player.pos.set(window.__spot[0], window.__spot[1], window.__spot[2]);
      Player.yaw = 0;
    }, 16);
    return 'pinned at ' + window.__spot.join(',');
  })()`);
  await evaluate(`window.__studio('front', 2.6, 1.0, 0.9); 1`);
  await sleep(900);
  await shot('_anim-walk-front');
  await evaluate(`window.__studio('left', 2.6, 1.0, 0.9); 1`);
  await sleep(900);
  await shot('_anim-walk-left');
  await evaluate(`window.__studio('front', 1.4, 1.5, 1.6); 1`);
  await sleep(900);
  await shot('_anim-head-front');
  await evaluate(`window.__studio('left', 1.5, 1.4, 1.5); 1`);
  await sleep(900);
  await shot('_anim-head-left');
  await evaluate(`window.__studio('front', 1.1, 0.35, 0.25); 1`);
  await sleep(900);
  await shot('_anim-feet-front');
  await evaluate(`window.__studio('left', 1.1, 0.35, 0.25); 1`);
  await sleep(900);
  await shot('_anim-feet-left');
  await evaluate(`clearInterval(window.__pin); window.__studio(''); 1`);

  ctx.check('probe ran', !parts.err, parts.err || 'ok');
};
