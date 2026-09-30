// Scratch probe: work out what actually moves the hands away from the weapon
// while a gun is carried, and how much of the gun-carry clip to take. Poses the
// rig at one phase and sweeps a scale on the clip's torso track (the carry
// posture) against one on its arm tracks, printing where the right hand ends up
// relative to the gun the model holds in front of its chest
// (gun origin 0.24, 0.98, 0.42 - its body spans y 0.92..1.04).
//
//   node cdp-test.js _armprobe
module.exports = async function armprobe(ctx) {
  const { evaluate, sleep } = ctx;

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

  const out = await evaluate(`(function () {
    document.getElementById('startScreen').classList.add('hidden');
    App.showScreen(null);
    App.state = 'PLAYING';
    if (!World.height) World.build(QUALITY_PRESETS.low, 7, 'isle');
    App.paused = true;
    Player.weapons = [{ id: 'ar', mag: 30 }]; Player.curSlot = 0;
    PlayerView.setWeapon('ar');
    Player.pos.set(0, World.heightAt(0, 0), 0);
    Player.vel.set(0, 0, -5.7);
    Player.alive = true; Player.hp = CONFIG.MAX_HP; Player.shield = 0;
    Player.yaw = 0; CAM.yaw = 0; CAM.pitch = 0;

    const group = App.scene.getObjectByName('playerCharacter');
    const rigObj = App.scene.getObjectByName('playerCharacterRig');
    const loco = PlayerView.loco();
    const PHASE = 0.33;
    /* a copy of the gun-carry clip with its arm and torso tracks scaled: the legs
       and hips stay exactly as baked, so only those contributions change */
    const ARMB = ['shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR'];
    const clips = window.FREDDY_ANIMS.clips;
    function scaled(armS, torsoS) {
      const c = {};
      for (const k in clips.walkArmed) c[k] = clips.walkArmed[k];
      c.bones = {};
      for (const n in clips.walkArmed.bones) c.bones[n] = clips.walkArmed.bones[n];
      const scale = function (n, s) {
        const tr = clips.walkArmed.bones[n];
        if (tr) c.bones[n] = tr.map(function (v) { return v * s; });   // flat xyz rows
      };
      for (const n of ARMB) scale(n, armS);
      scale('torso', torsoS);
      return c;
    }
    function read(armS, torsoS) {
      CharacterRig.setClips({ walk: clips.walk, run: clips.run, walkArmed: scaled(armS, torsoS) });
      return settle();
    }
    /* the shipped configuration: the sidecar as-is, so the runtime's own armedArm /
       armedPose shares are what is being measured */
    function readShipped() {
      CharacterRig.setClips(window.FREDDY_ANIMS);
      return settle();
    }
    function settle() {
      for (let i = 0; i < 90; i++) { loco.phase = PHASE; PlayerView.update(1 / 60, Player); }
      const bone = function (n) {
        const b = rigObj.getObjectByName('bone_' + n);
        const v = new THREE.Vector3();
        b.getWorldPosition(v);
        group.worldToLocal(v);
        return [v.x, v.y, v.z].map(function (n2) { return +n2.toFixed(3); });
      };
      const rot = function (n) {
        const b = rigObj.getObjectByName('bone_' + n);
        return [b.rotation.x, b.rotation.y, b.rotation.z].map(function (n2) { return +n2.toFixed(3); });
      };
      return { handR: bone('handR'), handL: bone('handL'), head: bone('head'),
               torsoRot: rot('torso'), shoulderRRot: rot('shoulderR'),
               weight: +loco.weight.toFixed(3), armed: +loco.armed.toFixed(3),
               cfg: [CONFIG.CHARACTER.anims.armedArm, CONFIG.CHARACTER.anims.armedPose] };
    }
    /* the clip's own arm curves at that phase, straight out of the sidecar
       (flat xyz rows, one key per frame - the same layout sampleTrack reads) */
    function curve(clip, name) {
      const tr = clip && clip.bones[name];
      if (!tr) return null;
      const n = clip.frames;
      const p = (PHASE % 1 + 1) % 1 * n;
      const i0 = Math.floor(p) % n, f = p - Math.floor(p), i1 = (i0 + 1) % n;
      const a = i0 * 3, b2 = i1 * 3;
      return [tr[a] + (tr[b2] - tr[a]) * f,
              tr[a + 1] + (tr[b2 + 1] - tr[a + 1]) * f,
              tr[a + 2] + (tr[b2 + 2] - tr[a + 2]) * f].map(function (v) { return +v.toFixed(3); });
    }
    const cases = [[0, 0], [0, 0.35], [0, 1], [0.6, 0], [0.6, 0.35], [0.6, 1]];
    const rows = [];
    for (const cse of cases) {
      rows.push({ arms: cse[0], torso: cse[1], at: read(cse[0], cse[1]) });
    }
    const shipped = readShipped();
    return {
      phase: PHASE,
      curves: {
        armedTorso: curve(clips.walkArmed, 'torso'),
        walkTorso: curve(clips.walk, 'torso'),
        armedShoulderR: curve(clips.walkArmed, 'shoulderR'),
        walkShoulderR: curve(clips.walk, 'shoulderR')
      },
      rows: rows,
      shipped: shipped
    };
  })()`);

  console.log('  phase ' + out.phase + '   gun 0.24, 0.98, 0.42 (body y 0.92..1.04)');
  console.log('  torso curve  armed ' + JSON.stringify(out.curves.armedTorso) +
    '   walk ' + JSON.stringify(out.curves.walkTorso));
  console.log('  arm   curve  armed ' + JSON.stringify(out.curves.armedShoulderR) +
    '   walk ' + JSON.stringify(out.curves.walkShoulderR));
  console.log('  armS torsoS  handR              handL              head');
  for (const r of out.rows) {
    console.log('  ' + String(r.arms).padEnd(5) + String(r.torso).padEnd(7) +
      JSON.stringify(r.at.handR).padEnd(19) + JSON.stringify(r.at.handL).padEnd(19) +
      JSON.stringify(r.at.head) + '  torso.rot ' + JSON.stringify(r.at.torsoRot));
  }
  const s = out.shipped;
  console.log('  SHIPPED (w ' + s.weight + ', armed ' + s.armed + ', cfg ' +
    JSON.stringify(s.cfg) + ')  handR ' + JSON.stringify(s.handR) +
    '  handL ' + JSON.stringify(s.handL) + '  head ' + JSON.stringify(s.head) +
    '  torso.rot ' + JSON.stringify(s.torsoRot) +
    '  shoulderR.rot ' + JSON.stringify(s.shoulderRRot));
};
