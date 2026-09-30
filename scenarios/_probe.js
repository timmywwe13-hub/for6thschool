// Throwaway diagnostic: is the held gun aligned with the character's facing, and
// where do his hands actually sit? Four orthogonal photographs plus the geometry.
const fs = require('fs');
const path = require('path');

module.exports = async function probe(ctx) {
  const { evaluate, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('  shot ' + name);
  }

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(800);
  console.log(await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    if (App.state === 'DROP') for (var i = 0; i < 600 && App.state === 'DROP'; i++) Game.update(0.2);
    window.__botsUpdate = Bots.update;
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
    Game.render = function (dt) {
      window.__origGameRender.call(Game, dt);
      var m = window.__studioMode;
      if (!m) return;
      var cam = App.camera;
      var f = new THREE.Vector3(Math.sin(Player.yaw), 0, -Math.cos(Player.yaw));
      var r = new THREE.Vector3(-f.z, 0, f.x);
      var p = new THREE.Vector3().copy(Player.pos);
      if (m === 'front') p.addScaledVector(f, 3.0);
      else if (m === 'back') p.addScaledVector(f, -3.0);
      else if (m === 'left') p.addScaledVector(r, -3.0);
      else p.addScaledVector(r, 3.0);
      p.y += 1.25;
      cam.position.copy(p);
      cam.lookAt(Player.pos.x, Player.pos.y + 0.9, Player.pos.z);
      App.renderer.render(App.scene, cam);
    };
    window.__studio = function (m) { window.__studioMode = m || ''; return window.__studioMode || 'off'; };
    Player.yaw = 0; CAM.yaw = 0; CAM.pitch = -0.02; CAM.sync();
    Player.vel.set(0, 0, 0);
    Player.weapons[0] = { id: 'ar', mag: 30 }; Player.curSlot = 0;
    Player.ammoReserve.medium = 300;
    Input.ads = true; Input.updateAxes();
    return 'state ' + App.state + ' armed ' + !!Player.wdef();
  })()`));
  await sleep(2500);
  console.log(await evaluate(`(function () {
    var ch = App.scene.getObjectByName('playerCharacter');
    var rig = ch.getObjectByName('playerCharacterRig');
    function bone(n) { var b = null; rig.traverse(function (o) { if (o.name === 'bone_' + n) b = o; }); return b; }
    var gun = null;
    ch.children.forEach(function (c) { if (c.isMesh && c.visible) gun = c; });
    function dir(o) {
      o.updateWorldMatrix(true, false);
      var v = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
      return [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
    }
    var gp = new THREE.Vector3();
    if (gun) gun.getWorldPosition(gp);
    var hp = new THREE.Vector3();
    var hand = bone('handR');
    if (hand) hand.getWorldPosition(hp);
    var deg = gun
      ? +(Math.acos(Math.max(-1, Math.min(1, new THREE.Vector3(0, 0, 1)
          .applyQuaternion(gun.getWorldQuaternion(new THREE.Quaternion()))
          .dot(new THREE.Vector3(0, 0, 1).applyQuaternion(ch.getWorldQuaternion(new THREE.Quaternion())))))) * 57.3).toFixed(1)
      : null;
    return JSON.stringify({
      gunFound: !!gun, gunPos: [+gp.x.toFixed(2), +gp.y.toFixed(2), +gp.z.toFixed(2)],
      handR: hand ? [+hp.x.toFixed(2), +hp.y.toFixed(2), +hp.z.toFixed(2)] : null,
      handToGun: hand ? +gp.distanceTo(hp).toFixed(2) : null,
      gunDirWorld: gun ? dir(gun) : null, bodyDirWorld: dir(ch),
      gunToBodyDeg: deg, camDir: [+CAM.dir.x.toFixed(2), +CAM.dir.y.toFixed(2), +CAM.dir.z.toFixed(2)],
      playerYaw: +Player.yaw.toFixed(2), adsT: +Player.adsT.toFixed(2)
    });
  })()`));

  const views = ['front', 'back', 'left', 'right'];
  for (const v of views) {
    await evaluate(`window.__studio(${JSON.stringify(v)}); 1`);
    await sleep(1200);
    await shot('_diag-aim-' + v);
  }
  await evaluate(`window.__studio(''); 1`);
};
