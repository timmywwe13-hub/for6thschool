// Animation probe: the polish pass checked mechanically instead of by eye.
//
//   * an explosion spawns a floating damage number, and it climbs on an
//     ease-out curve (fast off the hit, coasting), fades, and expires
//   * screen shake is a smooth function of the simulation clock, not per-frame
//     randomness: two renders at the same time give the same camera, and the
//     offset stays inside its amplitude
//   * a walking bot bobs and swings its arms, and the gait eases out when it
//     stops (the instanced bot view has no skeleton, so the pose IS the matrices)
//   * the view model answers the handling states: it dips for a reload, comes
//     up out of a swap and punches on a melee swing
//
//   node cdp-test.js _animcheck
module.exports = async function animcheck(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(900);
  await evaluate(`(function () {
    if (App.state === 'BUS') {
      for (var b = 0; b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; b++) Bus.update(1 / 60);
      Bus.jump();
    }
    for (var i = 0; i < 400 && App.state === 'DROP'; i++) Game.update(0.05);
    return App.state;
  })()`);

  /* ---------------- 1. the explosion damage number ---------------- */
  const num = await evaluate(`(function () {
    var out = {};
    var p = Player, t = BOTS[0];
    if (!t) return { err: 'no bots' };
    p.alive = true; p.hp = 1e6;                 // the blast may clip us: survive it
    p.weapons = [{ id: 'launcher', mag: 4 }]; p.curSlot = 0;
    p.reloadT = 0; p.nextShotT = 0; p.spreadExtra = 0; p.recoilKick = 0;
    p.ads = false; p.adsT = 0; p.crouching = false;
    /* the target four metres in front of the player, on whatever ground is there */
    var fx = Math.sin(CAM.yaw), fz = -Math.cos(CAM.yaw);
    var tx = p.pos.x + fx * 4, tz = p.pos.z + fz * 4;
    t.pos.set(tx, World.heightAt(tx, tz), tz);
    t.vel.set(0, 0, 0); t.alive = true; t.hp = 1e6; t.shield = 0;
    t.helmetTier = 0; t.vestTier = 0;
    entityGrid.clear();
    entityGrid.insert(p.pos.x, p.pos.z, p);
    entityGrid.insert(t.pos.x, t.pos.z, t);
    /* aim the way the game aims: settle the camera, then put the crosshair on the
       chest (yaw *and* pitch - the camera is over the shoulder, off the muzzle) */
    p.camReach = CONFIG.CAM_DIST;
    for (var k = 0; k < 8; k++) p.updateCamera(0.05);
    var adx = tx - CAM.pos.x, ady = (t.pos.y + 0.62) - CAM.pos.y, adz = tz - CAM.pos.z;
    CAM.yaw = Math.atan2(adx, -adz);
    CAM.pitch = Math.atan2(ady, Math.hypot(adx, adz));
    p.yaw = CAM.yaw;
    CAM.sync();
    /* drain the pooled numbers so the one this blast makes is unambiguous */
    FX.update(3);
    p.shootOne();
    /* one rocket, one detonation: the target is in the grid once, exactly as the
       real frame leaves it, so the blast damages it once */
    for (var s = 0; s < 200; s++) {
      Projectiles.update(0.01);
      if (t.hp < 1e6) break;
    }
    out.dealt = +(1e6 - t.hp).toFixed(2);
    var els = document.querySelectorAll('#dmgNums .dnum');
    var el = null;
    for (var i = 0; i < els.length; i++) {
      if (els[i].style.display !== 'none' && els[i].textContent) { el = els[i]; break; }
    }
    if (!el) return { err: 'no floating number spawned', dealt: out.dealt };
    out.text = el.textContent;
    out.left = el.style.left;
    /* walk the number's whole life a frame at a time */
    var seen = [];
    for (var f = 0; f < 90; f++) {
      FX.update(1 / 60);
      if (el.style.display === 'none') break;
      seen.push({ top: parseFloat(el.style.top), left: el.style.left,
                  op: parseFloat(el.style.opacity) });
    }
    out.frames = seen.length;
    out.expired = el.style.display === 'none';
    /* the text is placed with a fraction of a pixel, so it can never shiver
       between two whole-pixel positions the way .toFixed(0) made it */
    out.left = seen.length ? seen[0].left : '';
    out.fractional = seen.some(function (s) { return /\./.test(s.left) || /\./.test(String(s.top)); });
    var first = Math.floor(seen.length * 0.25), last = Math.floor(seen.length * 0.75);
    out.riseFast = +(seen[0].top - seen[first].top).toFixed(2);
    out.riseSlow = +(seen[last].top - seen[seen.length - 1].top).toFixed(2);
    out.topMonotonic = seen.every(function (s, i) { return i === 0 || s.top <= seen[i - 1].top + 0.001; });
    out.fadeMonotonic = seen.every(function (s, i) { return i === 0 || s.op <= seen[i - 1].op + 0.001; });
    out.lastOpacity = seen.length ? +seen[seen.length - 1].op.toFixed(2) : -1;
    return out;
  })()`);
  console.log('  damage number: ' + JSON.stringify(num));
  check('a grenade launcher hit spawns a floating damage number',
    !num.err && Number(num.text) > 0, num.err || 'damage ' + num.dealt + ' shown as "' + num.text + '"');
  check('the number matches the damage the blast actually dealt',
    !num.err && Math.abs(Number(num.text) - num.dealt) <= 1,
    num.err || 'text "' + num.text + '" vs ' + num.dealt + ' hp removed');
  check('the number climbs on an ease-out curve',
    num.riseFast > num.riseSlow && num.topMonotonic === true,
    'fast ' + num.riseFast + 'px early, ' + num.riseSlow + 'px late');
  check('the number is placed sub-pixel instead of snapping to whole pixels',
    num.fractional === true, 'sample left=' + num.left);
  check('the number fades out and returns to the pool',
    num.fadeMonotonic === true && num.expired === true && num.lastOpacity <= 0.2,
    num.frames + ' frames, last opacity ' + num.lastOpacity);

  /* ---------------- 2. screen shake ---------------- */
  const shake = await evaluate(`(function () {
    var out = {};
    var cam = App.camera;
    Player.alive = true; Player.hp = 1e6;
    FX.update(3);                                 // no shake left over from the blast
    Game.update(1 / 60);
    Game.render(1 / 60);
    out.noShakeExact = +cam.position.distanceTo(CAM.pos).toFixed(4);
    FX.addShake(0.6);
    var amp = FX.shake;
    Game.render(1 / 60);
    var a = cam.position.clone(), roll = cam.rotation.z;
    Game.render(1 / 60);                          // same sim time: same shake phase
    var b = cam.position.clone();
    out.identical = a.distanceTo(b) < 1e-9;
    out.bounded = Math.max(Math.abs(a.x - CAM.pos.x), Math.abs(a.y - CAM.pos.y),
                           Math.abs(a.z - CAM.pos.z)) <= amp * 0.42 + 1e-6;
    out.roll = Math.abs(roll) <= amp * 0.05 + 1e-6 && Math.abs(roll) > 0;
    Game.update(1 / 60);                          // time moves on: the shake moves with it
    Game.render(1 / 60);
    out.moved = +b.distanceTo(cam.position).toFixed(5);
    /* let it die out entirely */
    for (var i = 0; i < 60; i++) Game.update(1 / 60);
    Game.render(1 / 60);
    out.settled = +cam.position.distanceTo(CAM.pos).toFixed(6);
    return out;
  })()`);
  console.log('  screen shake: ' + JSON.stringify(shake));
  check('screen shake is a function of the sim clock, not per-frame randomness',
    shake.identical === true, 'two renders at the same sim time agree');
  check('screen shake rattles the camera while it lasts',
    shake.moved > 0.0005 && shake.roll === true, 'moved ' + shake.moved + ' m between frames');
  check('screen shake stays inside its amplitude', shake.bounded === true,
    'noShake idle offset ' + shake.noShakeExact);
  check('a settled camera sits exactly on the pivot',
    shake.noShakeExact === 0 && shake.settled === 0,
    'idle ' + shake.noShakeExact + ' m, after the shake ' + shake.settled + ' m');

  /* ---------------- 3. the bot gait ---------------- */
  const gait = await evaluate(`(function () {
    var out = {};
    var b = null;
    for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) { b = BOTS[i]; break; }
    if (!b) return { err: 'no live bot' };
    b.state = 'loot'; b.crouch = false;
    var m = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    function sample() {
      Bots.syncView(b, 1 / 60);
      BotView.body.getMatrixAt(b.index, m); m.decompose(v, q, s);
      var bodyY = v.y;
      BotView.arms.getMatrixAt(b.index * 2, m); m.decompose(v, q, s);
      var z0 = v.z;
      BotView.arms.getMatrixAt(b.index * 2 + 1, m); m.decompose(v, q, s);
      return { y: bodyY, apart: Math.abs(z0 - v.z) };
    }
    function range(frames) {
      var loY = Infinity, hiY = -Infinity, loA = Infinity, hiA = -Infinity;
      for (var f = 0; f < frames; f++) {
        var r = sample();
        if (r.y < loY) loY = r.y;
        if (r.y > hiY) hiY = r.y;
        if (r.apart < loA) loA = r.apart;
        if (r.apart > hiA) hiA = r.apart;
      }
      return { bob: +(hiY - loY).toFixed(4), swing: +(hiA - loA).toFixed(4) };
    }
    b.vel.set(0, 0, -5.2);                        // a walking bot
    range(30);                                    // let the gait blend in
    var walk = range(60);
    out.walkBob = walk.bob; out.walkSwing = walk.swing;
    b.vel.set(0, 0, 0);                           // stopped: the swing eases out
    range(150);
    var stop = range(30);
    out.stopBob = stop.bob; out.stopSwing = stop.swing;
    b.vel.set(0, 0, -5.2); b.state = 'drop';      // under a canopy there is no gait
    range(90);
    var drop = range(20);
    b.state = 'loot'; b.vel.set(0, 0, 0);
    out.droppingBob = drop.bob;
    return out;
  })()`);
  console.log('  bot gait: ' + JSON.stringify(gait));
  check('a walking bot bobs its body instead of sliding',
    gait.err ? false : gait.walkBob > 0.01, gait.err || gait.walkBob + ' m of bounce');
  check('a walking bot swings its arms',
    gait.err ? false : gait.walkSwing > 0.01, gait.err || gait.walkSwing + ' m of arm travel');
  check('the gait eases out when the bot stops',
    gait.err ? false : gait.stopBob < 0.004 && gait.stopSwing < 0.004,
    gait.err || gait.stopBob + ' m / ' + gait.stopSwing + ' m left moving');
  check('a bot under a canopy has no walk cycle',
    gait.err ? false : gait.droppingBob === 0, gait.err || gait.droppingBob + ' m of bounce');

  /* ---------------- 4. the view model's handling states ---------------- */
  const view = await evaluate(`(function () {
    var gun = App.scene.getObjectByName('playerGun');
    if (!gun) return { err: 'the view model has no gun object' };
    var p = Player;
    p.alive = true; p.weapons = [{ id: 'ar', mag: 30 }]; p.curSlot = 0;
    p.recoilKick = 0; p.recoilPitch = 0; p.ads = false; p.adsT = 0;
    p.reloadT = 0; p.reloadTotal = 0; p.swapT = 0; p.meleeT = 0;
    function settle() { for (var i = 0; i < 40; i++) PlayerView.update(1 / 60, p); }
    function look() {
      return { y: +gun.position.y.toFixed(4), z: +gun.position.z.toFixed(4),
               rx: +gun.rotation.x.toFixed(4) };
    }
    settle();
    var out = { idle: look() };
    p.reloadTotal = 2.35; p.reloadT = p.reloadTotal * 0.5;
    settle();
    out.reload = look();
    p.reloadTotal = 0; p.reloadT = 0;
    p.swapT = CONFIG.WEAPON_SWAP_TIME * 0.5;
    settle();
    out.swap = look();
    p.swapT = 0;
    p.meleeT = CONFIG.MELEE_TIME * 0.5;
    settle();
    out.melee = look();
    p.meleeT = 0;
    settle();
    out.after = look();
    return out;
  })()`);
  console.log('  view model: ' + JSON.stringify(view));
  check('the gun dips out of the sight line for a reload',
    !view.err && view.reload.y < view.idle.y - 0.10 && view.reload.rx > view.idle.rx + 0.4,
    view.err || 'y ' + view.idle.y + ' -> ' + view.reload.y + ', pitch ' + view.idle.rx + ' -> ' + view.reload.rx);
  check('the gun dips on a swap and comes back to rest',
    !view.err && view.swap.y < view.idle.y - 0.10 && view.after.y === view.idle.y,
    view.err || 'y ' + view.idle.y + ' -> ' + view.swap.y + ' -> ' + view.after.y);
  check('a melee swing punches the gun forward',
    !view.err && view.melee.z > view.idle.z + 0.08,
    view.err || 'z ' + view.idle.z + ' -> ' + view.melee.z);
};
