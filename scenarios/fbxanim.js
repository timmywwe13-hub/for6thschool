// FBX locomotion scenario: the walk and run cycles baked by tools/fbx-bake.js
// (from the Mixamo FBX clips) are what animate the player's limbs. Checks the
// data, the way speed drives it, that the procedural pose still takes over for
// the glide and the aim, and that it all still works with no sidecar at all.
// Run it with:  node cdp-test.js fbxanim
module.exports = async function fbxanim(ctx) {
  const { evaluate, check, sleep } = ctx;

  /* the model and the clips both load asynchronously at boot */
  await evaluate(`Character.load(); 'asked'`);
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const st = await evaluate(`(function () {
      return Character.anims.status + '/' +
        (App.scene.getObjectByName('playerCharacterRig') ? 'rig' : 'no-rig');
    })()`);
    if (st === 'ready/rig' || st === 'failed/rig') { ready = st === 'ready/rig'; break; }
    await sleep(200);
  }

  const anims = JSON.parse(await evaluate(`JSON.stringify(Character.anims)`));
  console.log('  Character.anims.status ' + anims.status + ' ' + anims.detail +
    ' (' + anims.bones + ' hinges)');
  check('the locomotion sidecar loads', anims.status === 'ready', anims.status + ' ' + anims.detail);
  check('the rig got the clips', ready, ready ? 'the rig is playing them' : 'rig or clips missing');

  /* ---------- what is in the baked tables ---------- */
  const table = JSON.parse(await evaluate(`(function () {
    var c = CharacterRig.clips();
    if (!c) return '{"none":true}';
    function swing(clip, bone) {
      var t = clip.bones[bone], lo = Infinity, hi = -Infinity;
      for (var i = 0; i < t.length; i += 3) { if (t[i] < lo) lo = t[i]; if (t[i] > hi) hi = t[i]; }
      return +(hi - lo).toFixed(3);
    }
    function bob(clip) {
      var lo = Math.min.apply(null, clip.bob), hi = Math.max.apply(null, clip.bob);
      return [+(hi - lo).toFixed(4), +(hi).toFixed(3), +(lo).toFixed(3)];
    }
    function trackMin(clip, bone) {
      if (!clip) return 0;
      var t = clip.bones[bone], lo = Infinity;
      for (var i = 0; i < t.length; i += 3) if (t[i] < lo) lo = t[i];
      return +lo.toFixed(3);
    }
    return JSON.stringify({
      walkFrames: c.walk.frames, runFrames: c.run.frames,
      walkDur: c.walk.duration, runDur: c.run.duration,
      walkHip: swing(c.walk, 'hipL'), runHip: swing(c.run, 'hipL'),
      walkKnee: swing(c.walk, 'kneeL'), runKnee: swing(c.run, 'kneeL'),
      walkBob: bob(c.walk), runBob: bob(c.run), hinges: Object.keys(c.walk.bones).length,
      crouchIdleFrames: c.crouchIdle ? c.crouchIdle.frames : 0,
      crouchWalkFrames: c.crouchWalk ? c.crouchWalk.frames : 0,
      crouchSink: c.crouchIdle ? +(c.crouchIdle.sink || 0).toFixed(3) : 0,
      crouchKnee: trackMin(c.crouchIdle, 'kneeL'),
      armedFrames: c.walkArmed ? c.walkArmed.frames : 0,
      armedDur: c.walkArmed ? c.walkArmed.duration : 0,
      armedHip: c.walkArmed ? swing(c.walkArmed, 'hipL') : 0,
      armedShoulder: c.walkArmed ? swing(c.walkArmed, 'shoulderR') : 0,
      armedBob: c.walkArmed ? bob(c.walkArmed) : [0, 0, 0]
    });
  })()`));
  console.log('  baked tables ' + JSON.stringify(table));
  check('both cycles are full length, a second of walk and less of run',
    table.walkFrames > 40 && table.runFrames > 30 && table.walkDur > table.runDur,
    table.walkFrames + ' / ' + table.runFrames + ' frames, ' +
    table.walkDur + ' s / ' + table.runDur + ' s');
  check('every hinge of the rig has a track', table.hinges === 14, table.hinges + ' hinges');
  check('the retargeted stride is real, and the run swings wider than the walk',
    table.walkHip > 0.8 && table.runHip > table.walkHip && table.runKnee > table.walkKnee,
    'hip ' + table.walkHip + ' -> ' + table.runHip + ' rad, knee ' +
    table.walkKnee + ' -> ' + table.runKnee + ' rad');
  check('the clips carry their own bounce', table.walkBob[0] > 0.01 && table.runBob[0] > 0.01,
    'walk ' + table.walkBob[0] + ' m, run ' + table.runBob[0] + ' m peak to peak');
  check('the crouch pair baked too, with its root sink and a deep knee fold',
    table.crouchIdleFrames > 100 && table.crouchWalkFrames > 40 &&
    table.crouchSink > 0.1 && table.crouchKnee > 1.5,
    'idle ' + table.crouchIdleFrames + ' frames, walk ' + table.crouchWalkFrames +
    ' frames, sink ' + table.crouchSink + ' m, knee ' + table.crouchKnee + ' rad');
  check('the gun-carry walk baked too: full length, legs striding, bounce of its own',
    table.armedFrames > 40 && table.armedHip > 0.5 && table.armedBob[0] > 0.005 &&
    table.armedShoulder < table.armedHip,
    table.armedFrames + ' frames (' + table.armedDur + ' s), hip ' + table.armedHip +
    ' rad, shoulder travel ' + table.armedShoulder + ' rad, bounce ' + table.armedBob[0] + ' m');

  /* ---------- driven by speed ----------
     The character is posed by PlayerView.update (the render loop's call), so
     the checks feed it a speed and step the view. */
  const drive = await evaluate(`(function () {
    var ch = App.scene.getObjectByName('playerCharacter');
    var model = ch && ch.getObjectByName('playerCharacterModel');
    var rig = App.scene.getObjectByName('playerCharacterRig');
    var bones = {};
    rig.traverse(function (o) { if (o.name && o.name.indexOf('bone_') === 0) bones[o.name.slice(5)] = o; });
    function step(n) { for (var k = 0; k < n; k++) PlayerView.update(1 / 60, Player); }
    function swing(bone) {
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i < 120; i++) {
        step(1);
        var v = bones[bone].rotation.x;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return +(hi - lo).toFixed(3);
    }
    /* cadence: how often the left hip crosses its own mean in two seconds */
    function cadence(speed) {
      Player.vel.set(0, 0, -speed);
      step(30);
      var samples = [], sum = 0;
      for (var i = 0; i < 120; i++) { step(1); samples.push(bones.hipL.rotation.x); }
      for (var j = 0; j < samples.length; j++) sum += samples[j];
      var mean = sum / samples.length, crossings = 0;
      for (var k = 1; k < samples.length; k++) {
        if (samples[k - 1] < mean && samples[k] >= mean) crossings++;
      }
      return crossings;
    }
    var out = {};
    Input.keys = Object.create(null);

    /* walking pace */
    Player.vel.set(0, 0, -5.7); step(20);
    out.walkWeight = +PlayerView.loco().weight.toFixed(3);
    out.walkRun = +PlayerView.loco().run.toFixed(3);
    out.walkLegs = swing('hipL');
    out.walkArms = swing('shoulderL');

    /* sprinting: the run cycle has to take over */
    Player.vel.set(0, 0, -8.6); step(40);
    out.runShare = +PlayerView.loco().run.toFixed(3);
    out.runWeight = +PlayerView.loco().weight.toFixed(3);
    out.sprintLegs = swing('hipL');

    /* cadence and bounce while moving */
    out.slowCadence = cadence(3.0);
    out.fastCadence = cadence(6.5);
    var loB = Infinity, hiB = -Infinity;
    Player.vel.set(0, 0, -5.7); step(30);
    for (var b = 0; b < 120; b++) {
      step(1);
      var y = model.position.y;
      if (y < loB) loB = y;
      if (y > hiB) hiB = y;
    }
    out.bobRange = +(hiB - loB).toFixed(4);

    /* gliding: the procedural pose takes the body back and the hands go up on
       the risers. With no canopy he is in freefall, and that pose spreads the
       arms out to the sides instead (see the rig's air branch). */
    Player.airborne = true; Player.gliderOpen = true;
    step(90);
    out.airWeight = +PlayerView.loco().weight.toFixed(3);
    out.airArm = +bones.shoulderL.rotation.x.toFixed(3);
    Player.gliderOpen = false;
    step(90);
    out.fallArm = +bones.shoulderL.rotation.x.toFixed(3);
    out.fallArmOut = +bones.shoulderL.rotation.z.toFixed(3);
    Player.airborne = false;

    /* armed: with the gun-carry walk in the sidecar the cycle owns the body - the
       legs stride and the arms keep the aim hold while picking up that clip's own
       swing. Then the same carry with a sidecar that has no gun-carry walk (an
       older build): the aim pose owns the arms outright, the legs still stride. */
    Player.weapons = [{ id: 'ar', mag: 30 }]; Player.curSlot = 0;
    Player.vel.set(0, 0, -6);
    step(60);
    out.armedWeight = +PlayerView.loco().armed.toFixed(3);
    out.armedLegs = swing('hipL');
    out.armedArm = +bones.shoulderR.rotation.x.toFixed(3);
    out.armedArmSwing = swing('shoulderR');
    /* the clip blades the chest hard at the weapon (its torso track carries about
       0.56 rad of yaw) and pitches the head down 0.47 rad. The gun hangs in front
       of the chest where the aim pose put it and cannot follow that, so both are
       taken at a share while a weapon is up: the hips and legs below them still
       take the clip whole (out.armedLegs above is the same clip's stride). */
    out.armedTorsoYaw = +Math.abs(bones.torso.rotation.y).toFixed(3);
    out.armedHeadPitch = +bones.head.rotation.x.toFixed(3);
    out.armedClipYaw = +Math.abs(CharacterRig.clips().walkArmed.bones.torso[
      Math.floor(0.5 * CharacterRig.clips().walkArmed.frames) * 3 + 1]).toFixed(3);
    var full = CharacterRig.clips();
    CharacterRig.setClips({ walk: full.walk, run: full.run });
    Player.vel.set(0, 0, -6);
    step(60);
    out.armedOldWeight = +PlayerView.loco().weight.toFixed(3);
    out.armedOldLegs = swing('hipL');
    out.armedOldArm = +bones.shoulderR.rotation.x.toFixed(3);
    out.armedOldArmSwing = swing('shoulderR');
    CharacterRig.setClips(full);
    Player.weapons = []; Player.curSlot = 0;
    step(60);

    /* crouched: the baked crouch pair owns the body - the knees fold deep, the
       root sinks so the feet stay planted, and a crouch walk keeps striding.
       Standing back up hands the body to the procedural pose again. */
    Player.crouching = true; Player.vel.set(0, 0, 0); step(90);
    out.crouchWeight = +PlayerView.loco().weight.toFixed(3);
    out.crouchShare = +PlayerView.loco().crouch.toFixed(3);
    out.crouchKnee = +bones.kneeL.rotation.x.toFixed(3);
    out.crouchRootY = +model.position.y.toFixed(3);
    Player.vel.set(0, 0, -2.8); step(60);
    out.crouchMove = +PlayerView.loco().crouchMove.toFixed(3);
    out.crouchWalkLegs = swing('hipL');
    Player.crouching = false; Player.vel.set(0, 0, 0); step(90);
    out.standKnee = +bones.kneeL.rotation.x.toFixed(3);

    /* no sidecar: the sine cycle still has to move him */
    CharacterRig.setClips(null);
    Player.vel.set(0, 0, -6);
    step(30);
    out.noClipWeight = +PlayerView.loco().weight.toFixed(3);
    out.noClipLegs = swing('hipL');
    return out;
  })()`);
  console.log('  driven by speed ' + JSON.stringify(drive));

  check('the cycle drives the limbs at walking pace',
    drive.walkWeight > 0.9 && drive.walkLegs > 0.8,
    'clip weight ' + drive.walkWeight + ', hip swing ' + drive.walkLegs + ' rad');
  check('the run cycle takes over when sprinting',
    drive.runShare > 0.6 && drive.runWeight > 0.9 && drive.sprintLegs > drive.walkLegs - 0.05,
    'run share ' + drive.runShare + ', hip swing ' + drive.sprintLegs + ' rad');
  check('the cadence follows the speed', drive.fastCadence > drive.slowCadence,
    drive.slowCadence + ' hip passes at 3 m/s vs ' + drive.fastCadence + ' at 6.5 m/s');
  check('the bounce comes out of the clip', drive.bobRange > 0.005 && drive.bobRange < 0.2,
    drive.bobRange + ' m peak to peak at walking pace');
  check('gliding hands the body back to the procedural pose',
    drive.airWeight < 0.02 && drive.airArm < -1.4,
    'clip weight ' + drive.airWeight + ', arm ' + drive.airArm);
  check('freefall spreads the arms instead of raising them overhead',
    drive.fallArm > -1.4 && Math.abs(drive.fallArmOut) > 0.8,
    'freefall arm ' + drive.fallArm + ' rad up / ' + drive.fallArmOut + ' rad out');
  check('carrying a gun hands the body to the gun-carry cycle',
    drive.armedWeight > 0.8 && drive.armedLegs > 0.2,
    'armed share ' + drive.armedWeight + ', hip swing ' + drive.armedLegs + ' rad');
  check('the arms keep the aim hold and pick up the carry cycle\'s own swing',
    drive.armedArm < -0.9 && drive.armedArmSwing > 0.02 && drive.armedArmSwing < 0.6,
    'shoulder ' + drive.armedArm + ' rad, travel ' + drive.armedArmSwing + ' rad');
  check('the carry posture is taken at a share, so the gun stays in his hands',
    drive.armedClipYaw > 0.4 && drive.armedTorsoYaw > 0.02 &&
    drive.armedTorsoYaw < drive.armedClipYaw * 0.6 &&
    drive.armedHeadPitch > 0 && drive.armedHeadPitch < 0.28,
    'clip blades the chest ' + drive.armedClipYaw + ' rad, the pose takes ' +
    drive.armedTorsoYaw + ' rad, head pitch ' + drive.armedHeadPitch + ' rad');
  check('an older sidecar (no gun-carry walk) still hands the arms back while armed',
    drive.armedOldWeight > 0.8 && drive.armedOldLegs > 0.2 &&
    drive.armedOldArm < -0.9 && drive.armedOldArmSwing < 0.02,
    'clip weight ' + drive.armedOldWeight + ', hip swing ' + drive.armedOldLegs +
    ' rad, arm ' + drive.armedOldArm + ' rad with ' + drive.armedOldArmSwing + ' rad of travel');
  check('crouching lets the baked crouch own the body: knees fold, the root sinks',
    drive.crouchWeight > 0.9 && drive.crouchShare > 0.9 &&
    drive.crouchKnee > 1.5 && drive.crouchRootY < -0.15,
    'weight ' + drive.crouchWeight + ', crouch share ' + drive.crouchShare +
    ', knee ' + drive.crouchKnee + ' rad, root ' + drive.crouchRootY + ' m');
  check('a crouch walk is still a real stride, not a squash',
    drive.crouchMove > 0.6 && drive.crouchWalkLegs > 0.4,
    'move share ' + drive.crouchMove + ', hip swing ' + drive.crouchWalkLegs + ' rad');
  check('standing back up straightens the knees',
    drive.standKnee < 0.3, 'knee ' + drive.standKnee + ' rad');
  check('with no sidecar the sine cycle still moves him',
    drive.noClipWeight < 0.05 && drive.noClipLegs > 0.25,
    'clip weight ' + drive.noClipWeight + ', hip swing ' + drive.noClipLegs + ' rad');
};
