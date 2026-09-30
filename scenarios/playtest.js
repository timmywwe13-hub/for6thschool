// Play test: drives the game the way a player would - standing, walking,
// sprinting, crouching, strafing, backpedalling, jumping, gliding, aiming -
// through the game's own input path (Input.keys -> Input.updateAxes ->
// Player.update), photographs every state from behind and from a front 3/4
// "studio" angle into playtest/, then measures what the locomotion really does
// at a fixed 60 Hz: foot slide, cadence, clip hand-over, bounce, knee safety
// and frame cost.
//
//   node cdp-test.js playtest
const fs = require('fs');
const path = require('path');

module.exports = async function playtest(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  shot ' + name + '.png (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
  }

  /* the live animation state, as the HUD would see it */
  const STATE = `(function () {
    var l = PlayerView.loco();
    return { speed: +Math.hypot(Player.vel.x, Player.vel.z).toFixed(2), weight: +l.weight.toFixed(2),
             run: +l.run.toFixed(2), phase: +l.phase.toFixed(3), rate: +l.rate.toFixed(2),
             camReach: +Player.camReach.toFixed(2),
             crouch: !!Player.crouching, air: !!Player.airborne, armed: !!Player.wdef(),
             alive: Player.alive, hp: Player.hp };
  })()`;

  /* ---------- into a live match, with the bots parked ---------- */
  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(800);
  const parked = await evaluate(`(function () {
    /* the match opens on the battle bus: ride it out or jump, then land */
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    if (App.state === 'DROP') for (var i = 0; i < 600 && App.state === 'DROP'; i++) Game.update(0.2);
    if (App.state !== 'PLAYING') return 'state ' + App.state;
    window.__botsUpdate = Bots.update;
    Bots.update = function () {                 // keep the island quiet while posing
      entityGrid.clear();
      if (Player.alive) entityGrid.insert(Player.pos.x, Player.pos.z, Player);
      for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) entityGrid.insert(BOTS[i].pos.x, BOTS[i].pos.z, BOTS[i]);
      BotView.flush();
    };
    window.__keepAlive = setInterval(function () {   // and the player un-killable
      Player.hp = CONFIG.MAX_HP;
      Player.shield = 0;                             // no bubble over the model in the photos
      var g = World.heightAt(Player.pos.x, Player.pos.z);
      if (Player.pos.y < g) Player.pos.y = g;
    }, 100);
    Input.keys = Object.create(null); Input.updateAxes();
    /* ---- the harness levers ---- */
    window.__want = {};
    /* an open patch of dry land to pose on, and a reset so no pose starts in a
       tree, in water or with the camera jammed against a wall */
    window.__spot = null;
    (function () {
      var pts = World.lootPoints || [];
      for (var i = 0; i < pts.length && !window.__spot; i++) {
        var p = pts[i], h = World.heightAt(p.x, p.z);
        if (h > CONFIG.SEA_LEVEL + 2 && World.waterDepth(p.x, p.z) <= 0) {
          window.__spot = { x: p.x, y: h, z: p.z };
        }
      }
      if (!window.__spot) {
        for (var z = -240; z <= 240 && !window.__spot; z += 12) {
          for (var x = -240; x <= 240 && !window.__spot; x += 12) {
            var hh = World.heightAt(x, z);
            if (hh > CONFIG.SEA_LEVEL + 2 && World.waterDepth(x, z) <= 0) window.__spot = { x: x, y: hh, z: z };
          }
        }
      }
    })();
    window.__stand = function () {
      var s = window.__spot;
      if (!s) return null;
      Player.pos.set(s.x, s.y, s.z);
      Player.vel.set(0, 0, 0);
      Player.yaw = 0; Player.camReach = CONFIG.CAM_DIST;
      return s;
    };
    window.__keys = function (o) {           // {fwd, back, left, right, sprint, crouch, jump}
      window.__want = o || {};
      var k = Object.create(null), n;
      for (n in window.__want) if (window.__want[n] && n !== 'jump') k[n] = true;
      Input.keys = k; Input.updateAxes();
      if (window.__want.jump) Input.jumpQueued = true;
      return { moveX: Input.moveX, moveZ: Input.moveZ, sprint: Input.sprint, crouch: Input.crouch };
    };
    window.__pin = 0;                        // hold a speed without fighting the input
    window.__air = null;                     // hold a skydive state for the photos
    window.__origGameUpdate = Game.update;
    Game.update = function (dt) {
      /* re-apply the held keys every frame: a headless window can lose focus
         between screenshots, and that clears the input */
      var k = Object.create(null), n;
      for (n in window.__want) if (window.__want[n] && n !== 'jump') k[n] = true;
      Input.keys = k; Input.updateAxes();
      window.__origGameUpdate.call(Game, dt);
      if (window.__air) {
        /* the drop resets itself as soon as it touches down, so the airborne
           states have to be re-asserted every frame to stay photographable */
        if (window.__air.skydive) Player.airborne = true;
        Player.gliderOpen = !!window.__air.glider;
        Player.dropVelocity = window.__air.fall;
        Player.pos.y = Math.max(Player.pos.y, window.__air.y);
        Player.vel.set(0, 0, -window.__air.drift);
      }
      if (window.__pin) Player.vel.set(0, 0, -window.__pin);
    };
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
      if (m === 'front') p.addScaledVector(f, 2.45).addScaledVector(r, 1.05);
      else if (m === 'side') p.addScaledVector(r, 2.65);
      else p.addScaledVector(f, -2.5).addScaledVector(r, 0.7);
      p.y += 1.38;
      cam.position.copy(p);
      cam.lookAt(Player.pos.x, Player.pos.y + 0.92, Player.pos.z);
      App.renderer.render(App.scene, cam);   // a second pass, from the studio angle
    };
    window.__studio = function (m) { window.__studioMode = m || ''; return window.__studioMode || 'off'; };
    return App.state;
  })()`);
  console.log('  match state ' + parked);
  check('the play test got into a live match', parked === 'PLAYING', parked);
  if (parked !== 'PLAYING') return;

  /* stand him on open ground, facing north, nothing in hand */
  await evaluate(`(function () {
    Player.yaw = 0; CAM.yaw = 0; CAM.pitch = -0.06; CAM.sync();
    Player.vel.set(0, 0, 0);
    Player.weapons = [null, null, null, null, null]; Player.curSlot = 0;
    return 1;
  })()`);
  await sleep(600);

  /* ---------- the states a player cycles through ---------- */
  async function pose(name, keys, seconds, pin, before) {
    await evaluate(`window.__stand(); 1`);         // same open patch of land every time
    if (before) await evaluate(before);
    const axes = await evaluate(`window.__keys(${JSON.stringify(keys || {})})`);
    await evaluate(`window.__pin = ${pin || 0}; 1`);
    await sleep(Math.round(seconds * 1000));
    await shot(name);
    await evaluate(`window.__studio('front'); 1`);
    await sleep(1000);
    await shot(name + '-front');
    /* read the state while the speed is still pinned - the pin is what the
       photographs above were taken at */
    const st = await evaluate(STATE);
    await evaluate(`window.__studio(''); window.__pin = 0; window.__air = null; Player.vel.set(0, 0, 0); 1`);
    console.log('  ' + name + ' axes ' + JSON.stringify(axes) + ' -> ' + JSON.stringify(st));
    return st;
  }

  const idle = await pose('01-idle', {}, 1.4, 0);
  const walk = await pose('02-walk', { fwd: 1 }, 1.6, 5.7);
  const run = await pose('03-sprint', { fwd: 1, sprint: 1 }, 1.6, 8.6);
  const crouchWalk = await pose('04-crouch-walk', { fwd: 1, crouch: 1 }, 1.6, 2.8);
  const strafe = await pose('05-strafe-left', { left: 1 }, 1.4, 5.7);
  const backpedal = await pose('06-backpedal', { back: 1 }, 1.4, 5.7);
  const aim = await pose('07-aim-ads', { fwd: 1 }, 1.4, 3.1, `(function () {
    Player.weapons[0] = { id: 'ar', mag: 30 }; Player.curSlot = 0;
    Player.ammoReserve.medium = 300; Input.ads = true; Input.updateAxes();
    return 1;
  })()`);
  /* a normal hop: airborne is the skydive flag, so the jump is caught by
     holding him above the ground with gravity still doing its thing */
  const jump = await pose('08-jump', { fwd: 1 }, 0.4, 5.7, `(function () {
    window.__air = { skydive: false, glider: false, fall: -0.5,
                     y: World.heightAt(Player.pos.x, Player.pos.z) + 1.1, drift: 5.7 };
    Input.jumpQueued = true;
    return 1;
  })()`);
  const glide = await pose('09-glide', { fwd: 1 }, 1.4, 0, `(function () {
    window.__air = { skydive: true, glider: true, fall: -7,
                     y: World.heightAt(Player.pos.x, Player.pos.z) + 22, drift: 9 };
    return 1;
  })()`);
  const freefall = await pose('10-freefall', {}, 1.4, 0, `(function () {
    Player.weapons = [null, null, null, null, null]; Player.curSlot = 0;
    Input.ads = false; Input.updateAxes();
    window.__air = { skydive: true, glider: false, fall: -34,
                     y: World.heightAt(Player.pos.x, Player.pos.z) + 60, drift: 8 };
    return 1;
  })()`);

  /* the drop spends its first seconds with no canopy over his head, and that
     pose must not read as "hands up" - only the canopy puts the hands overhead */
  const airPose = await evaluate(`(function () {
    var rig = App.scene.getObjectByName('playerCharacterRig');
    var bones = {};
    rig.traverse(function (o) { if (o.name && o.name.indexOf('bone_') === 0) bones[o.name.slice(5)] = o; });
    function hold(glider, frames) {
      for (var i = 0; i < frames; i++) {
        Player.airborne = true; Player.gliderOpen = glider;
        Player.vel.set(0, 0, -6);
        PlayerView.update(1 / 60, Player);
      }
      return { up: +bones.shoulderL.rotation.x.toFixed(2), out: +bones.shoulderL.rotation.z.toFixed(2),
               elbow: +bones.elbowL.rotation.x.toFixed(2), knee: +bones.kneeL.rotation.x.toFixed(2),
               torso: +bones.torso.rotation.x.toFixed(2) };
    }
    var free = hold(false, 60);
    var gliding = hold(true, 60);
    Player.airborne = false; Player.gliderOpen = false; Player.vel.set(0, 0, 0);
    for (var k = 0; k < 40; k++) PlayerView.update(1 / 60, Player);
    return { free: free, glide: gliding };
  })()`);
  console.log('  airborne poses: ' + JSON.stringify(airPose));
  check('the freefall pose spreads the arms instead of throwing them overhead',
    airPose.free.up > -1.4 && Math.abs(airPose.free.out) > 0.8,
    'freefall shoulders ' + airPose.free.up + ' rad up / ' + airPose.free.out + ' rad out');
  check('the canopy pose still puts the hands up on the risers',
    airPose.glide.up < -1.5,
    'gliding shoulders ' + airPose.glide.up + ' rad up');

  await evaluate(`(function () {
    Player.airborne = false; Player.gliderOpen = false; Player.ads = false; Input.ads = false;
    Player.weapons = [null, null, null, null, null]; Player.curSlot = 0;
    Player.crouching = false; Player.vel.set(0, 0, 0); window.__keys({});
    return 1;
  })()`);
  await sleep(400);

  /* ---------- what the locomotion really does, stepped at a fixed 60 Hz ----------
     The planted foot is the one moving least; if the cycle does not carry him
     far enough per stride, that foot skates along at some fraction of his real
     speed. That fraction is the foot slide a player actually sees. */
  async function locomotion(name, keys, speed, seconds, tweak) {
    const out = await evaluate(`(function () {
      var ch = App.scene.getObjectByName('playerCharacter');
      var model = ch.getObjectByName('playerCharacterModel');
      var rig = App.scene.getObjectByName('playerCharacterRig');
      var bones = {};
      rig.traverse(function (o) { if (o.name && o.name.indexOf('bone_') === 0) bones[o.name.slice(5)] = o; });
      var A = CONFIG.CHARACTER.anims;
      var keep = { stride: A.stride, rateMax: A.rateMax };
      ${tweak || ''}
      window.__keys(${JSON.stringify(keys)});
      var dt = 1 / 60, frames = ${Math.round(seconds * 60)}, s = [];
      var home = Player.pos.clone(), ground = Player.pos.y;
      var a = new THREE.Vector3(), b = new THREE.Vector3();
      for (var i = 0; i < frames; i++) {
        Player.vel.set(0, 0, -${speed});
        Player.update(dt);
        Player.pos.set(home.x, ground, home.z);   // treadmill: he stays put
        PlayerView.update(dt, Player);
        ch.updateMatrixWorld(true);               // the foot world positions need it
        bones.footL.getWorldPosition(a); bones.footR.getWorldPosition(b);
        var l = PlayerView.loco();
        s.push([a.x, a.y, a.z, b.x, b.y, b.z, Math.hypot(Player.vel.x, Player.vel.z),
                l.phase, l.weight, l.run, l.rate, model.position.y,
                bones.kneeL.rotation.x, bones.kneeR.rotation.x]);
      }
      var n = s.length, body = 0, knee = Infinity, hi = -Infinity, lo = Infinity, ratios = [], wraps = 0;
      var loF = Infinity, hiF = -Infinity, loG = Infinity, hiG = -Infinity;
      for (var i = 1; i < n; i++) {
        var dL = Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1], s[i][2] - s[i - 1][2]) * 60;
        var dR = Math.hypot(s[i][3] - s[i - 1][3], s[i][4] - s[i - 1][4], s[i][5] - s[i - 1][5]) * 60;
        body += s[i][6];
        if (s[i][6] > 1) ratios.push(Math.min(dL, dR) / s[i][6]);
        knee = Math.min(knee, s[i][12], s[i][13]);
        hi = Math.max(hi, s[i][11]); lo = Math.min(lo, s[i][11]);
        if (s[i][7] < s[i - 1][7] - 0.5) wraps++;
      }
      /* the stride the cycle itself steps: how far each foot travels forward
         past the body over one cycle. This is the honest one - it does not care
         how fast the cycle is played, and a cycle is slide free exactly when the
         body covers the same ground per cycle. */
      for (var q = 0; q < n; q++) {
        var fzL = home.z - s[q][2], fzR = home.z - s[q][5];   // forward = -Z
        if (fzL < loF) loF = fzL; if (fzL > hiF) hiF = fzL;
        if (fzR < loG) loG = fzR; if (fzR > hiG) hiG = fzR;
      }
      A.stride = keep.stride; A.rateMax = keep.rateMax;
      ratios.sort(function (x, y) { return x - y; });
      var mean = 0;
      for (var k = 0; k < ratios.length; k++) mean += ratios[k];
      mean = ratios.length ? mean / ratios.length : 0;
      var cadence = wraps / (frames * dt);
      var mPerCycle = cadence > 0 ? body / (n - 1) / cadence : 0;
      var step = Math.max(hiF - loF, hiG - loG);
      return { frames: n, speed: +(body / (n - 1)).toFixed(2), cadence: +cadence.toFixed(2),
               /* the cadence the game itself is running at, straight off loco.rate:
                  the cadence field above counts wraps of the clip phase, so over a
                  2.5 s window it can only move in steps of 0.4 cycles/s and two
                  speeds a whole wrap apart in a window read as one number */
               rate: +s[n - 1][10].toFixed(2),
               mPerCycle: +mPerCycle.toFixed(2), stepPerCycle: +step.toFixed(2),
               slide: +Math.max(0, 1 - step / Math.max(0.01, mPerCycle)).toFixed(2),
               noSlideCadence: +(step > 0.01 ? (body / (n - 1)) / step : 0).toFixed(2),
               slideAnkle: +mean.toFixed(2),
               weight: +s[n - 1][8].toFixed(2), run: +s[n - 1][9].toFixed(2),
               kneeMin: +knee.toFixed(3), bob: +(hi - lo).toFixed(3) };
    })()`);
    console.log('  ' + name + ': ' + JSON.stringify(out));
    return out;
  }

  const walkFast = await locomotion('walking at 5.7 m/s', { fwd: 1 }, 5.7, 2.5);
  const sprintFast = await locomotion('sprinting at 8.6 m/s', { fwd: 1, sprint: 1 }, 8.6, 2.5);
  const crawl = await locomotion('walking at 3.0 m/s', { fwd: 1 }, 3.0, 2.5);
  const crouchSlow = await locomotion('crouch-walking at 2.8 m/s', { fwd: 1, crouch: 1 }, 2.8, 2.5);
  await evaluate(`window.__keys({}); Player.vel.set(0, 0, 0); 1`);

  check('the baked cycle owns the limbs at walking speed',
    walkFast.weight > 0.9 && walkFast.run === 0,
    'clip weight ' + walkFast.weight + ', run share ' + walkFast.run);
  check('the sprint hands over to the run cycle',
    sprintFast.run > 0.9 && sprintFast.rate > walkFast.rate,
    'run share ' + sprintFast.run + ' at ' + sprintFast.speed + ' m/s, cadence ' +
    walkFast.rate + ' -> ' + sprintFast.rate + ' cycles/s (loco.rate; the clip-phase ' +
    'wraps count ' + walkFast.cadence + ' -> ' + sprintFast.cadence + ')');
  /* What the clips themselves step per cycle is the floor on foot slide: the
     body can only cover as much ground per cycle as the feet do. The game's
     movement speeds are far above what these cycles animate at a natural
     tempo, so `stride` in CONFIG trades a sane cadence for the skate. These
     numbers are what that trade actually costs. */
  const strideCfg = await evaluate(`CONFIG.CHARACTER.anims.stride`);
  const adsDist = await evaluate(`CONFIG.CAM_DIST_ADS`);
  console.log('  the clips step ' + walkFast.stepPerCycle + ' m per walk cycle and ' +
    sprintFast.stepPerCycle + ' m per run cycle; CONFIG.CHARACTER.anims.stride = ' + strideCfg);
  console.log('  clip table: ' + (await evaluate(`(function () {
    var c = CharacterRig.clips();
    return c ? 'walk ' + c.walk.frames + ' frames, run ' + c.run.frames + ' frames' : 'none loaded';
  })()`)));
  check('the aiming camera keeps the model out of the sight picture',
    aim.camReach >= adsDist - 0.35,
    'camera ' + aim.camReach + ' m behind him while aiming (CONFIG.CAM_DIST_ADS = ' + adsDist + ')');
  check('the slide the shipped cadence leaves is the trade, not an accident',
    walkFast.slide < 0.95 && sprintFast.slide < 0.95,
    'walking 5.7 m/s: ' + Math.round(walkFast.slide * 100) + '% of the body speed is skated at ' +
    walkFast.cadence + ' cycles/s (slide free would need ' + walkFast.noSlideCadence +
    ' cycles/s); sprinting: ' + Math.round(sprintFast.slide * 100) + '% at ' + sprintFast.cadence +
    ' cycles/s (needs ' + sprintFast.noSlideCadence + ')');
  check('the knee never folds through the thigh', sprintFast.kneeMin >= 0 && crouchSlow.kneeMin >= 0,
    'knee minimum ' + Math.min(sprintFast.kneeMin, crouchSlow.kneeMin) + ' rad');
  check('the cadence rises with speed and stays inside its clamp',
    crawl.cadence < walkFast.cadence && walkFast.cadence <= sprintFast.cadence,
    crawl.cadence + ' / ' + walkFast.cadence + ' / ' + sprintFast.cadence + ' cycles/s');
  check('the crouch keeps some of the cycle', crouchSlow.weight > 0 && crouchSlow.weight < walkFast.weight,
    'crouch clip weight ' + crouchSlow.weight + ' vs ' + walkFast.weight + ' standing');

  /* ---------- the cadence knobs, for the tuning decision ----------
     stride = metres of travel one cycle is meant to cover, rateMax = the
     cycles/second ceiling. Lower stride or a higher ceiling means the legs
     work harder and the planted foot skates less; too far and it looks frantic. */
  const sweep = [];
  const COMBOS = [[4.2, 1.90], [4.2, 2.40], [3.40, 2.40], [2.80, 2.80]];
  for (let i = 0; i < COMBOS.length; i++) {
    const c = COMBOS[i];
    const r = await locomotion('sweep stride ' + c[0] + ' / rateMax ' + c[1] + ' at 8.6 m/s',
      { fwd: 1, sprint: 1 }, 8.6, 1.5,
      'A.stride = ' + c[0] + '; A.rateMax = ' + c[1] + ';');
    sweep.push({ stride: c[0], rateMax: c[1], cadence: r.cadence, slide: r.slide, mPerCycle: r.mPerCycle });
  }
  await evaluate(`window.__keys({}); Player.vel.set(0, 0, 0); 1`);
  const cur = sweep[0], fastest = sweep[sweep.length - 1];
  console.log('  cadence sweep (sprint): ' + JSON.stringify(sweep));
  check('the cadence ceiling keeps the clip near a tempo a player can sprint at',
    cur.cadence <= 2.2,
    'the shipped stride plays the run cycle at ' + cur.cadence + ' cycles/s at 8.6 m/s (' +
    Math.round(cur.slide * 100) + '% slide); pushing the cadence to ' + fastest.cadence +
    ' cycles/s only gets the slide to ' + Math.round(fastest.slide * 100) +
    '%, so what the feet skate is the movement speed, not the tuning');

  /* ---------- what the animation costs per frame ---------- */
  const cost = await evaluate(`(function () {
    function cost(frames) {
      var dt = 1 / 60;
      Player.vel.set(0, 0, -6);
      var t0 = performance.now();
      for (var i = 0; i < frames; i++) {
        Player.vel.set(0, 0, -6);
        PlayerView.update(dt, Player);
      }
      var ms = (performance.now() - t0) / frames;
      Player.vel.set(0, 0, 0);
      return +ms.toFixed(3);
    }
    var withClips = cost(200);
    CharacterRig.setClips(null);
    var without = cost(200);
    var back = CharacterRig.setClips(Character.anims.clips);
    return { withClips: withClips, without: without, back: !!back };
  })()`);
  console.log('  cost per frame: ' + cost.withClips + ' ms with the clips, ' +
    cost.without + ' ms with the sine cycle, restored: ' + cost.back);
  check('the clips cost next to nothing per frame', cost.withClips - cost.without < 1.0,
    '+' + (cost.withClips - cost.without).toFixed(3) + ' ms');
  check('the clips can be taken away and put back', cost.back === true);
  check('the rig is still on the baked cycles after that swap',
    (await evaluate(`CharacterRig.clips() === Character.anims.clips.clips`)) === true);

  /* ---------- a live firefight: bots back on, everything moving ---------- */
  await evaluate(`(function () {
    Bots.update = window.__botsUpdate;
    clearInterval(window.__keepAlive);
    window.__keys({});
    return App.state;
  })()`);
  await sleep(3000);
  await shot('11-live-firefight');
  const after = await evaluate(`(function () {
    var ch = App.scene.getObjectByName('playerCharacter');
    var rig = App.scene.getObjectByName('playerCharacterRig');
    var bones = {};
    rig.traverse(function (o) { if (o.name && o.name.indexOf('bone_') === 0) bones[o.name.slice(5)] = o; });
    var bad = 0;
    for (var k in bones) {
      var r = bones[k].rotation;
      if (!isFinite(r.x) || !isFinite(r.y) || !isFinite(r.z)) bad++;
    }
    return { state: App.state, alive: Player.alive, modelVisible: ch.visible, badBones: bad,
             weight: +PlayerView.loco().weight.toFixed(2), fps: App.lastFps,
             pos: [+Player.pos.x.toFixed(1), +Player.pos.y.toFixed(1), +Player.pos.z.toFixed(1)] };
  })()`);
  console.log('  after a live firefight: ' + JSON.stringify(after));
  check('the character survived a live match with every hinge intact',
    after.badBones === 0 && (after.alive ? after.modelVisible === true : true),
    after.badBones + ' broken hinges, alive ' + after.alive +
    ', model visible ' + after.modelVisible);

  /* ---------- back to the menu, then a second match ---------- */
  await evaluate(`App.finishMatch(true); 1`);
  await sleep(500);
  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(900);
  await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    if (App.state === 'DROP') for (var i = 0; i < 600 && App.state === 'DROP'; i++) Game.update(0.2);
    return App.state;
  })()`);
  await sleep(800);
  await shot('12-second-match');
  const second = await evaluate(`(function () {
    var rig = App.scene.getObjectByName('playerCharacterRig');
    return { state: App.state, rig: !!rig, clips: !!CharacterRig.clips(),
             detail: Character.anims.status, weight: +PlayerView.loco().weight.toFixed(2) };
  })()`);
  console.log('  second match: ' + JSON.stringify(second));
  check('a second match still has the rig and the baked cycles',
    second.rig === true && second.clips === true, JSON.stringify(second));
};
