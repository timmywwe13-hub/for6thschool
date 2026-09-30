// Character scenario: the player is the loaded Freddy model (rigged, walking,
// with moving arms and legs) while every bot stays a bean. Run it with:
//   node cdp-test.js charactermodel
module.exports = async function charactermodel(ctx) {
  const { evaluate, check, sleep } = ctx;

  /* the model loads asynchronously at boot: wait for it to settle */
  await evaluate(`(function () {
    window.__chars = null;
    Character.load().then(function (m) { window.__chars = m ? 'ready' : 'null'; },
                          function () { window.__chars = 'rejected'; });
    return 'asked';
  })()`);
  for (let i = 0; i < 100; i++) {
    const done = await evaluate(`window.__chars || Character.state.status`);
    if (done === 'ready' || done === 'null' || done === 'rejected' || done === 'failed') break;
    await sleep(200);
  }

  const st = await evaluate(`JSON.stringify(Character.state)`);
  const state = JSON.parse(st);
  console.log('  Character.state ' + st);
  check('vendor/GLTFLoader.js gives the page a GLTFLoader',
    await evaluate(`typeof THREE.GLTFLoader === 'function'`), await evaluate(`typeof THREE.GLTFLoader`));
  check('the character file loads', state.status === 'ready', state.status + ' ' + state.detail);
  check('the file brought its meshes and textures', state.meshes === 6 && state.textures >= 3,
    state.meshes + ' meshes, ' + state.textures + ' textures');

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(600);
  await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < 600 && App.state === 'DROP'; i++) Game.update(0.2);
    return App.state;
  })()`);
  check('a match reaches the ground', await evaluate(`App.state`) === 'PLAYING', await evaluate(`App.state`));

  /* ---------- the player is Freddy, the bots are beans ---------- */
  const shape = await evaluate(`(function () {
    var ch = App.scene.getObjectByName('playerCharacter');
    var holder = ch && ch.getObjectByName('playerCharacterModel');
    var rig = holder && holder.getObjectByName('playerCharacterRig');
    var bones = 0, meshes = 0, tris = 0;
    if (rig) rig.traverse(function (o) {
      if (o.name && o.name.indexOf('bone_') === 0) bones++;
      if (o.isMesh) { meshes++; tris += o.geometry.attributes.position.count / 3; }
    });
    var box = new THREE.Box3().setFromObject(holder || ch);
    return {
      hasHolder: !!holder, rigged: !!rig, bones: bones, rigMeshes: meshes,
      triangles: Math.round(tris),
      height: +(box.max.y - box.min.y).toFixed(2),
      primitivesHidden: ch.children.every(function (c) { return !c.isMesh || !c.visible; }),
      botBody: BotView.body.geometry.type, botHead: BotView.head.geometry.type,
      botInstanced: !!BotView.body.isInstancedMesh
    };
  })()`);
  console.log('  player model: ' + JSON.stringify(shape));
  check('the player character model is in the scene', shape.hasHolder === true);
  check('the fallback humanoid primitives are hidden', shape.primitivesHidden === true);
  check('the static model was rigged onto hinges', shape.rigged === true,
    shape.bones + ' bones, ' + shape.rigMeshes + ' meshes, ' + shape.triangles + ' triangles');
  check('the rig has a spine, a neck, two arms and two legs', shape.bones === 14, shape.bones + ' bones');
  check('the character is player sized', shape.height > 1.4 && shape.height < 2.1, shape.height + ' m');
  check('the bots are still beans (capsules + spheres, one instanced mesh)',
    shape.botBody === 'CapsuleGeometry' && shape.botHead === 'SphereGeometry' && shape.botInstanced === true,
    shape.botBody + ' / ' + shape.botHead);
  /* ---------- the limbs actually move ----------
     The character is posed by PlayerView.update (the render loop calls it with
     the live player state), so the state a check sets up - a speed, a crouch,
     an airborne flag - has to be fed straight to the view. scenarios/items.js
     drives the view the same way. The stride is measured over a whole cycle,
     not between two samples: two points a third of a cycle apart can sit
     symmetrically about the peak of a swing and hide it. */
  const walk = await evaluate(`(function () {
    var rig = App.scene.getObjectByName('playerCharacterRig');
    var bones = {};
    rig.traverse(function (o) { if (o.name && o.name.indexOf('bone_') === 0) bones[o.name.slice(5)] = o; });
    function step(n) { for (var k = 0; k < n; k++) PlayerView.update(1 / 60, Player); }
    Player.vel.set(0, 0, -6); Input.keys = Object.create(null);
    function span(bone, axis) {
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i < 120; i++) {                 // two seconds of running
        step(1);
        var v = bones[bone].rotation[axis];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return { range: +(hi - lo).toFixed(3), lo: +lo.toFixed(3), hi: +hi.toFixed(3) };
    }
    var hipL = span('hipL', 'x'), hipR = span('hipR', 'x');
    var kneeL = span('kneeL', 'x'), kneeR = span('kneeR', 'x');
    var armL = span('shoulderL', 'x'), armR = span('shoulderR', 'x');
    return { hipL: hipL, hipR: hipR, kneeL: kneeL, kneeR: kneeR, armL: armL, armR: armR,
             minKnee: +Math.min(kneeL.lo, kneeR.lo).toFixed(3) };
  })()`);
  console.log('  stride swing ' + JSON.stringify(walk));
  check('the legs swing while running', walk.hipL.range > 0.25 && walk.hipR.range > 0.25,
    'hip swing ' + walk.hipL.range + ' / ' + walk.hipR.range + ' rad over one cycle');
  check('the arms swing while running', walk.armL.range > 0.15 && walk.armR.range > 0.15,
    'shoulder swing ' + walk.armL.range + ' / ' + walk.armR.range + ' rad');
  check('the knees only fold backwards (never through the thigh)', walk.minKnee >= 0,
    'knee minimum ' + walk.minKnee + ' rad');

  /* ---------- the pose follows the state ---------- */
  const poses = await evaluate(`(function () {
    var rig = App.scene.getObjectByName('playerCharacterRig');
    var bones = {};
    rig.traverse(function (o) { if (o.name && o.name.indexOf('bone_') === 0) bones[o.name.slice(5)] = o; });
    var out = {};
    function step(n) { for (var k = 0; k < n; k++) PlayerView.update(1 / 60, Player); }
    Player.vel.set(0, 0, 0);
    step(90);                                                 // settle into idle
    out.idleArm = +bones.shoulderL.rotation.x.toFixed(3);
    Player.crouching = true;
    step(90);
    out.crouchKnee = +bones.kneeL.rotation.x.toFixed(3);
    out.crouchHip = +bones.hipL.rotation.x.toFixed(3);
    Player.crouching = false;
    /* the canopy puts the hands overhead on the risers; with no canopy he is in
       freefall and the arms spread instead - the two poses have to differ */
    Player.airborne = true; Player.gliderOpen = true;
    step(90);
    out.airArm = +bones.shoulderL.rotation.x.toFixed(3);
    Player.gliderOpen = false;
    step(90);
    out.fallArm = +bones.shoulderL.rotation.x.toFixed(3);
    out.fallArmOut = +bones.shoulderL.rotation.z.toFixed(3);
    Player.airborne = false;
    Player.weapons = [{ id: 'ar', mag: 30 }]; Player.curSlot = 0;
    step(90);
    out.armedArm = +bones.shoulderR.rotation.x.toFixed(3);
    out.armedElbow = +bones.elbowR.rotation.x.toFixed(3);
    return out;
  })()`);
  console.log('  poses: ' + JSON.stringify(poses));
  check('crouching folds the knees', poses.crouchKnee > 0.6, poses.crouchKnee);
  check('gliding raises the arms overhead', poses.airArm < -1.4, poses.airArm);
  check('freefall spreads the arms out instead of overhead',
    poses.fallArm > -1.4 && Math.abs(poses.fallArmOut) > 0.8,
    poses.fallArm + ' rad up, ' + poses.fallArmOut + ' rad out');
  check('holding a gun lifts the arms into an aiming pose', poses.armedArm < -0.9,
    'right shoulder ' + poses.armedArm + ', elbow ' + poses.armedElbow);
};
