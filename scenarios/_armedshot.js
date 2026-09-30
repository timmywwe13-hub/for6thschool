// Scratch probe: photograph the gun-carry walk so the pose can be eyeballed.
// Poses the rig by hand at three points of the cycle (armed, walking) and
// captures a close-up of the upper body, plus the numbers behind the pose -
// hand/gun distance, the armed weight and the arm's travel - so the clips are
// judged against each other rather than on vibes alone.
//
//   node cdp-test.js _armedshot   ->  playtest/armed-walk-0..2.png
const fs = require('fs');
const path = require('path');

module.exports = async function armedshot(ctx) {
  const { evaluate, send, sleep } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  for (let i = 0; i < 80; i++) {
    const st = await evaluate(`(function () {
      try {
        return Character.anims.status + '/' +
          (App.scene.getObjectByName('playerCharacterRig') ? 'rig' : 'no-rig');
      } catch (e) { return 'boot'; }
    })()`);
    if (st === 'ready/rig' || st === 'failed/rig') break;
    await sleep(200);
  }

  const setup = await evaluate(`(function () {
    document.getElementById('startScreen').classList.add('hidden');
    App.showScreen(null);
    App.state = 'PLAYING';
    /* a world has to exist for the lights and the sky, or everything renders black */
    if (!World.height) World.build(QUALITY_PRESETS.low, 7, 'isle');
    App.paused = true;                       // the sim is frozen; the pose is manual
    Player.weapons = [{ id: 'ar', mag: 30 }]; Player.curSlot = 0;
    PlayerView.setWeapon('ar');
    /* the world may not be built yet at the menu; the pose does not need ground */
    Player.pos.set(0, (World.height && World.heightAt) ? World.heightAt(0, 0) : 2, 0);
    Player.vel.set(0, 0, -5.7);
    Player.alive = true; Player.hp = CONFIG.MAX_HP; Player.shield = 0;
    Player.yaw = 0; CAM.yaw = 0; CAM.pitch = 0;
    const cam = App.camera;
    window.__frame = function () {
      cam.position.set(1.75, World.heightAt(0, 0) + 1.25, -2.35);
      cam.lookAt(new THREE.Vector3(0, World.heightAt(0, 0) + 0.95, 0));
      cam.far = Math.max(cam.far, 100);
      cam.updateProjectionMatrix();
    };
    window.__frame();
    /* poseAt: put the cycle at the given phase and let the eased arm pose settle */
    const phases = [0, 0.33, 0.66];
    window.__shot = function (i) {
      const loco = PlayerView.loco();
      for (let k = 0; k < 12; k++) {
        loco.phase = phases[i];
        PlayerView.update(1 / 60, Player);
      }
      /* where the hands sit relative to the gun (both in the character group) */
      const group = App.scene.getObjectByName('playerCharacter');
      /* with the model attached the only visible mesh in the group is the gun */
      const gun = group.children.filter(function (o) { return o.isMesh && o.visible; })[0] || null;
      const rig = App.scene.getObjectByName('playerCharacterRig');
      function boneWorld(name) {
        const b = rig.getObjectByName('bone_' + name);
        if (!b) return null;
        const v = new THREE.Vector3();
        b.getWorldPosition(v);
        return group.worldToLocal(v).toArray().map(function (n) { return +n.toFixed(3); });
      }
      /* the pose call may leave the follow camera in charge; put the shot
         camera back before the next rendered frame */
      window.__frame();
      return {
        phase: phases[i], armed: +loco.armed.toFixed(3), weight: +loco.weight.toFixed(3),
        handR: boneWorld('handR'), handL: boneWorld('handL'),
        footL: boneWorld('footL'), footR: boneWorld('footR'),
        gunPos: gun ? gun.position.toArray().map(function (n) { return +n.toFixed(3); }) : null,
        state: App.state, paused: !!App.paused,
        cam: cam.position.toArray().map(function (n) { return +n.toFixed(1); })
      };
    };
    return { rigged: !!App.scene.getObjectByName('playerCharacterRig') };
  })()`);
  console.log('  setup: ' + JSON.stringify(setup));

  for (let i = 0; i < 3; i++) {
    const info = await evaluate(`window.__shot(${i})`);
    await sleep(420);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, 'armed-walk-' + i + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  shot armed-walk-' + i + '.png (' + Math.round(fs.statSync(file).size / 1024) +
      ' KB) ' + JSON.stringify(info));
  }

  /* A/B: the same three poses with the gun-carry clip taken out of the rig, so
     the new armed arms can be judged against the aim-pose arms they replace */
  const ab = await evaluate(`(function () {
    const clips = window.FREDDY_ANIMS && window.FREDDY_ANIMS.clips;
    if (!clips || !clips.walkArmed) return { armed: 'missing' };
    CharacterRig.setClips({ walk: clips.walk, run: clips.run });
    return { armed: 'dropped' };
  })()`);
  console.log('  ab: ' + JSON.stringify(ab));

  for (let i = 0; i < 3; i++) {
    const info = await evaluate(`window.__shot(${i})`);
    await sleep(420);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, 'aim-walk-' + i + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  shot aim-walk-' + i + '.png (' + Math.round(fs.statSync(file).size / 1024) +
      ' KB) ' + JSON.stringify(info));
  }
};
