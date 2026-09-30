// Throwaway diagnostic for the character rig: the rest geometry of the hinge
// tree (pivots, limb lengths, the A-pose offset of the arms), how far the paws
// really reach, and where the held gun sits relative to the hands. Run with:
//   node cdp-test.js rigprobe
module.exports = async function rigprobe(ctx) {
  const { evaluate, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  /* The character model arrives from a data URL a few hundred ms after the match
     starts. Waiting a fixed second is fine on an idle machine and a crash under
     load (four browsers): `playerCharacter` was not in the scene yet and the
     probe died on undefined.getObjectByName. So wait for the object itself. */
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await evaluate(`!!(App.scene && App.scene.getObjectByName('playerCharacter'))`);
    if (!ready) await sleep(250);
  }
  await sleep(400);
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
    Player.yaw = 0; CAM.yaw = 0; CAM.pitch = 0; CAM.sync();
    Player.vel.set(0, 0, 0);
    return App.state;
  })()`);
  await sleep(400);

  /* ---------- the rest geometry: the hinges with every bone at zero ---------- */
  const rest = await evaluate(`(function () {
    var ch = App.scene.getObjectByName('playerCharacter');
    var holder = ch.getObjectByName('playerCharacterModel');
    var root = ch.getObjectByName('playerCharacterRig');
    var bones = {};
    root.traverse(function (o) { if (o.name && o.name.indexOf('bone_') === 0) bones[o.name.slice(5)] = o; });
    var saved = {};
    for (var k in bones) { saved[k] = bones[k].rotation.toArray(); bones[k].rotation.set(0, 0, 0); }
    root.updateWorldMatrix(true, true);
    function local(o) {                       // a point of the rig, in the rig's own space
      return root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    }
    var piv = {}, names = Object.keys(bones);
    for (var i = 0; i < names.length; i++) {
      var p = local(bones[names[i]]);
      piv[names[i]] = [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
    }
    /* how far the paw itself reaches past its hinge (bbox in rig space) */
    var paw = {};
    root.traverse(function (o) {
      if (!o.isMesh) return;
      ['L', 'R'].forEach(function (side) {
        if (o.name !== 'rig_hand' + side) return;
        var box = new THREE.Box3().setFromObject(o);
        var c = box.getCenter(new THREE.Vector3());
        root.worldToLocal(c);
        var lo = root.worldToLocal(box.min.clone()), hi = root.worldToLocal(box.max.clone());
        paw[side] = { c: [+c.x.toFixed(3), +c.y.toFixed(3), +c.z.toFixed(3)],
                      size: [+(hi.x - lo.x).toFixed(3), +(hi.y - lo.y).toFixed(3), +(hi.z - lo.z).toFixed(3)] };
      });
    });
    /* the model's own body box: how far the belly sticks out and where the head is */
    var body = new THREE.Box3().setFromObject(holder);
    var bl = root.worldToLocal(body.min.clone()), bh = root.worldToLocal(body.max.clone());
    for (var k2 in saved) bones[k2].rotation.fromArray(saved[k2]);
    root.updateWorldMatrix(true, true);
    function seg(a, b) {
      return +Math.sqrt(Math.pow(piv[a][0] - piv[b][0], 2) + Math.pow(piv[a][1] - piv[b][1], 2) +
                        Math.pow(piv[a][2] - piv[b][2], 2)).toFixed(3);
    }
    function ang(a, b) {                       // degrees off straight down, in the frontal plane
      var dx = piv[b][0] - piv[a][0], dy = piv[b][1] - piv[a][1];
      return { fromDown: +(Math.atan2(Math.abs(dx), Math.abs(dy)) * 57.3).toFixed(1),
               z: +(Math.atan2(piv[b][2] - piv[a][2], -dy) * 57.3).toFixed(1) };
    }
    return {
      pivots: piv,
      upper: { L: seg('shoulderL', 'elbowL'), R: seg('shoulderR', 'elbowR') },
      fore: { L: seg('elbowL', 'handL'), R: seg('elbowR', 'handR') },
      shoulderToHand: { L: seg('shoulderL', 'handL'), R: seg('shoulderR', 'handR') },
      armAngle: { L: ang('shoulderL', 'handL'), R: ang('shoulderR', 'handR') },
      paw: paw,
      body: { min: [+bl.x.toFixed(3), +bl.y.toFixed(3), +bl.z.toFixed(3)],
              max: [+bh.x.toFixed(3), +bh.y.toFixed(3), +bh.z.toFixed(3)] }
    };
  })()`);
  console.log('  rest geometry: ' + JSON.stringify(rest, null, 1));

  /* ---------- where the paws land, and where the gun is, while armed ---------- */
  const reach = await evaluate(`(function () {
    var ch = App.scene.getObjectByName('playerCharacter');
    var root = ch.getObjectByName('playerCharacterRig');
    var bones = {};
    root.traverse(function (o) { if (o.name && o.name.indexOf('bone_') === 0) bones[o.name.slice(5)] = o; });
    Player.weapons = [{ id: 'ar', mag: 30 }]; Player.curSlot = 0;
    Player.ammoReserve.medium = 300; Input.ads = true; Input.updateAxes();
    for (var i = 0; i < 120; i++) PlayerView.update(1 / 60, Player);
    root.updateWorldMatrix(true, true);
    function local(o) { return root.worldToLocal(o.getWorldPosition(new THREE.Vector3())); }
    var l = {};
    for (var k in bones) { var p = local(bones[k]); l[k] = [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]; }
    var gun = null;
    ch.children.forEach(function (c) { if (c.isMesh && c.visible) gun = c; });
    var gLocal = null;
    if (gun) {
      gun.geometry.computeBoundingBox();
      var b = gun.geometry.boundingBox;
      gLocal = { box: [b.min.toArray().map(function (v) { return +v.toFixed(3); }),
                       b.max.toArray().map(function (v) { return +v.toFixed(3); })],
                 pos: gun.position.toArray().map(function (v) { return +v.toFixed(3); }),
                 rot: gun.rotation.toArray().slice(0, 3).map(function (v) { return +v.toFixed(3); }) };
    }
    function d(a, b) { return +Math.sqrt(Math.pow(a[0]-b[0],2)+Math.pow(a[1]-b[1],2)+Math.pow(a[2]-b[2],2)).toFixed(3); }
    /* the muzzle point the game fires from: (right 0.22, y 0.99, forward 0.95) */
    var muzzle = [0.22, 0.99, 0.95];
    return { bones: l, gun: gLocal, gunParent: gun ? gun.parent.name : null,
             adsT: +Player.adsT.toFixed(2),
             handToGun: gun ? d(l.handR, gLocal.pos) : null,
             handLToGun: gun ? d(l.handL, gLocal.pos) : null,
             shoulderToGun: gun ? d(l.shoulderR, gLocal.pos) : null,
             shoulderRToMuzzle: d(l.shoulderR, muzzle),
             shoulderLToMuzzle: d(l.shoulderL, muzzle) };
  })()`);
  console.log('  armed pose: ' + JSON.stringify(reach, null, 1));
};
