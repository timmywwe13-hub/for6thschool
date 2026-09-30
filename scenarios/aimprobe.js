// Aim probe: one shot at long range with every intermediate value printed, to
// find why third-person convergence misses at distance.
module.exports = async function aimprobe(ctx) {
  const { evaluate, check, sleep } = ctx;
  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1000);

  const info = await evaluate(`(function () {
    /* sandbox: only BOTS[0] stays alive so we can aim at it in peace */
    Bots.update = function () {
      entityGrid.clear();
      if (Player.alive) entityGrid.insert(Player.pos.x, Player.pos.z, Player);
      for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) entityGrid.insert(BOTS[i].pos.x, BOTS[i].pos.z, BOTS[i]);
      BotView.flush();
    };
    for (var i = 1; i < BOTS.length; i++) { BOTS[i].alive = false; BotView.hide(BOTS[i].index); }
    var t = BOTS[0];
    t.alive = true; t.hp = 1e9; t.shield = 0; t.helmetTier = 0; t.vestTier = 0;

    var spot = null;
    for (var i = 0; i < World.lootPoints.length && !spot; i++) {
      var s = World.lootPoints[i], h = World.heightAt(s.x, s.z);
      if (h < 3 || h > 26) continue;
      var ok = true;
      /* The lane has to be clear for the line the game really shoots along: the
         muzzle (0.99 m up, 0.95 m ahead) to the target's chest. Checking only
         from the eye leaves lanes where a crest clears the eye but swallows the
         shot - the probe then blames convergence for a blocked ray. */
      for (var d = 3; d <= 70 && ok; d += 8) {
        var cy = World.heightAt(s.x, s.z - d) + 0.62;
        if (!World.losClear(s.x, h + 1.68, s.z, s.x, cy, s.z - d)) ok = false;
        if (!World.losClear(s.x, h + 0.99, s.z - 0.95, s.x, cy, s.z - d)) ok = false;
      }
      if (ok) spot = { x: s.x, z: s.z, y: h };
    }
    if (!spot) return { err: 'no lane' };
    window.__aim = { spot: spot, target: t };

    Player.pos.set(spot.x, spot.y, spot.z);
    Player.vel.set(0, 0, 0); Player.grounded = true; Player.airborne = false;
    Player.alive = true; Player.hp = 100;
    Player.yaw = 0;                             // face -Z, same as CAM.yaw below
    var dist = 70;
    var tz = spot.z - dist, tgy = World.heightAt(spot.x, tz);
    t.pos.set(spot.x, tgy, tz);
    entityGrid.clear();
    entityGrid.insert(Player.pos.x, Player.pos.z, Player);
    entityGrid.insert(t.pos.x, t.pos.z, t);

    /* stand the third-person camera up the way the game does */
    CAM.yaw = 0; CAM.pitch = 0; CAM.sync();
    Player.pos.set(spot.x, spot.y, spot.z);
    Player.camReach = CONFIG.CAM_DIST;
    for (var i = 0; i < 10; i++) Player.updateCamera(0.05);

    /* Aim the way a player aims: put the crosshair on the chest. The camera sits
       over the right shoulder (CONFIG.CAM_SHOULDER_ADS), so the YAW has to be
       corrected as well as the pitch - aiming by pitch alone leaves the reticle
       ~0.46 m to the right of the target at 70 m, which is the radius of its body
       sphere, and then ordinary spread scatters the shots off the edge of it. The
       camera also orbits behind the aim direction, so aiming moves the camera:
       iterate until it settles. */
    var chestY = tgy + 0.62;
    function aimAt(tx, ty, tz) {
      for (var it = 0; it < 6; it++) {
        Player.updateCamera(0.05);
        var ex = tx - CAM.pos.x, ey = ty - CAM.pos.y, ez = tz - CAM.pos.z;
        CAM.yaw = Math.atan2(ex, -ez);
        CAM.pitch = Math.atan2(ey, Math.hypot(ex, ez) || 1e-6);
        CAM.sync();
      }
      Player.updateCamera(0.05);
      Player.yaw = CAM.yaw;                    // the character has turned to face the aim
    }
    aimAt(t.pos.x, chestY, t.pos.z);

    var out = { cam: [CAM.pos.x, CAM.pos.y, CAM.pos.z], camDir: [CAM.dir.x, CAM.dir.y, CAM.dir.z],
                playerYaw: +Player.yaw.toFixed(4), crouch: Player.crouching };
    var dxc = t.pos.x - CAM.pos.x, dyc = chestY - CAM.pos.y, dzc = t.pos.z - CAM.pos.z;
    var lenc = Math.sqrt(dxc * dxc + dyc * dyc + dzc * dzc);
    out.chestDist = +lenc.toFixed(2);
    /* how far off the chest the crosshair ray now passes: 0 means it is on it */
    var along = dxc * CAM.dir.x + dyc * CAM.dir.y + dzc * CAM.dir.z;
    out.reticleMiss = +Math.sqrt(Math.max(0, lenc * lenc - along * along)).toFixed(3);
    out.camShoulder = +Math.hypot(CAM.pos.x - Player.pos.x, CAM.pos.z - Player.pos.z).toFixed(2);

    var camHit = Hit.hitscan(CAM.pos.x, CAM.pos.y, CAM.pos.z, CAM.dir.x, CAM.dir.y, CAM.dir.z, 300, Player);
    out.camHit = { t: +camHit.t.toFixed(2), bot: camHit.bot ? camHit.bot.name : null, head: camHit.head,
                   world: camHit.world };
    var aimX = CAM.pos.x + CAM.dir.x * camHit.t;
    var aimY = CAM.pos.y + CAM.dir.y * camHit.t;
    var aimZ = CAM.pos.z + CAM.dir.z * camHit.t;
    out.aim = [+aimX.toFixed(2), +aimY.toFixed(2), +aimZ.toFixed(2)];
    out.targetChest = [+t.pos.x.toFixed(2), +chestY.toFixed(2), +t.pos.z.toFixed(2)];

    var fwdX = Math.sin(Player.yaw), fwdZ = -Math.cos(Player.yaw);
    var rgtX = Math.cos(Player.yaw), rgtZ = Math.sin(Player.yaw);
    var mx = Player.pos.x + fwdX * 0.95 + rgtX * 0.22;
    var my = Player.pos.y + 0.99;
    var mz = Player.pos.z + fwdZ * 0.95 + rgtZ * 0.22;
    out.muzzle = [+mx.toFixed(2), +my.toFixed(2), +mz.toFixed(2)];
    var ddx = aimX - mx, ddy = aimY - my, ddz = aimZ - mz;
    var dl = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    out.muzzleToAim = +dl.toFixed(2);
    out.dirDot = +((ddx / dl) * CAM.dir.x + (ddy / dl) * CAM.dir.y + (ddz / dl) * CAM.dir.z).toFixed(4);

    /* what does a shot fired along that direction actually hit? */
    var mHit = Hit.hitscan(mx, my, mz, ddx / dl, ddy / dl, ddz / dl, 300, Player);
    out.muzzleHit = { t: +mHit.t.toFixed(2), bot: mHit.bot ? mHit.bot.name : null,
                      head: mHit.head, world: mHit.world };
    /* and where is the ray at the target's depth? */
    var depth = t.pos.z - mz;
    var yAt = my + (ddy / dl) * (depth / (ddz / dl));
    out.rayYAtTarget = +yAt.toFixed(3);
    out.chestY = +chestY.toFixed(3);
    out.verticalMiss = +(yAt - chestY).toFixed(3);
    return out;
  })()`);
  /* the first half is a pure diagnostic - print it, or the miss it explains is
     invisible in the log */
  console.log('  probe: ' + JSON.stringify(info));
  /* ---- second half: mimic the weapons harness exactly (CAM.pos set to the eye) ---- */
  const legacy = await evaluate(`(function () {
    var p = Player, t = window.__aim ? window.__aim.target : BOTS[0];
    var spot = window.__aim ? window.__aim.spot : null;
    if (!spot) return { err: 'no spot from the first probe' };
    var w = CONFIG.WEAPONS.ar;
    p.weapons = [null, null, null, null, null]; p.curSlot = 0;
    p.reloadT = 0; p.nextShotT = 0; p.spreadExtra = 0; p.burstLeft = 0;
    p.ammoReserve = { light: 500, medium: 500, heavy: 500, shells: 500, rockets: 50 };
    p.addWeapon('ar');
    p.weapons[0].mag = w.mag;
    p.ads = true; p.adsT = 1; p.crouching = false;
    t.hp = 1e9;
    var dist = 70;
    p.pos.set(spot.x, spot.y, spot.z);
    var tz = spot.z - dist, tgy = World.heightAt(spot.x, tz);
    t.pos.set(spot.x, tgy, tz);
    entityGrid.clear();
    entityGrid.insert(p.pos.x, p.pos.z, p);
    entityGrid.insert(t.pos.x, t.pos.z, t);
    /* EXACTLY what scenarios/weapons.js does: eye height, which is 1.68 m */
    CAM.yaw = 0;
    CAM.pos.set(spot.x, spot.y + 1.68, spot.z);
    CAM.pitch = Math.atan2((tgy + 0.62) - CAM.pos.y, dist);
    CAM.sync();
    var out = { playerYaw: +Player.yaw.toFixed(3), camY: +CAM.pos.y.toFixed(2),
                pitch: +CAM.pitch.toFixed(4) };
    var camHit = Hit.hitscan(CAM.pos.x, CAM.pos.y, CAM.pos.z, CAM.dir.x, CAM.dir.y, CAM.dir.z, 160, Player);
    out.camHitsBot = camHit.bot ? camHit.bot.name : null;
    out.camT = +camHit.t.toFixed(2);
    out.camWorld = camHit.world;
    var before = t.hp, hits = 0;
    for (var i = 0; i < 12; i++) {
      p.weapons[0].mag = w.mag;
      p.spreadExtra = 0;
      var hp0 = t.hp;
      p.shootOne();
      if (t.hp < hp0) hits++;
    }
    out.hits = hits;
    out.perShot = +((before - t.hp) / 12).toFixed(2);
    t.hp = 1e9;
    return out;
  })()`);
  console.log('  legacy-aim replay: ' + JSON.stringify(legacy));

  /* ---- and the same shot with the camera left in its real third-person spot ---- */
  const proper = await evaluate(`(function () {
    var p = Player, t = (window.__aim && window.__aim.target) || BOTS[0];
    var spot = (window.__aim && window.__aim.spot) || null;
    if (!spot) return { err: 'no spot' };
    var w = CONFIG.WEAPONS.ar;
    p.weapons = [{ id: 'ar', mag: w.mag }];
    p.curSlot = 0; p.reloadT = 0; p.nextShotT = 0; p.spreadExtra = 0;
    p.ammoReserve.medium = 500;
    p.ads = true; p.adsT = 1;
    t.hp = 1e9;
    var dist = 70;
    p.pos.set(spot.x, spot.y, spot.z);
    var tz = spot.z - dist, tgy = World.heightAt(spot.x, tz);
    t.pos.set(spot.x, tgy, tz);
    entityGrid.clear();
    entityGrid.insert(p.pos.x, p.pos.z, p);
    entityGrid.insert(t.pos.x, t.pos.z, t);
    Player.yaw = 0;
    CAM.yaw = 0; CAM.pitch = 0;
    Player.camReach = CONFIG.CAM_DIST;
    /* let the game place the camera, then aim the crosshair at the chest from
       wherever it is - yaw and pitch, exactly as a player does (see the note in
       the first probe: pitch alone leaves the reticle off the target) */
    for (var i = 0; i < 6; i++) {
      Player.updateCamera(0.05);
      var ex = t.pos.x - CAM.pos.x, ey = (tgy + 0.62) - CAM.pos.y, ez = t.pos.z - CAM.pos.z;
      CAM.yaw = Math.atan2(ex, -ez);
      CAM.pitch = Math.atan2(ey, Math.hypot(ex, ez) || 1e-6);
      CAM.sync();
    }
    Player.updateCamera(0.05);
    Player.yaw = CAM.yaw;
    var before = t.hp, hits = 0, spread0 = 0;
    for (var i = 0; i < 12; i++) {
      p.weapons[0].mag = w.mag;
      p.spreadExtra = 0;
      if (i === 0) spread0 = p.currentSpread();      // the spread the first shot rolls
      var hp0 = t.hp;
      p.shootOne();
      if (t.hp < hp0) hits++;
    }
    /* the crosshair sits on the chest, not beside it */
    var vx = t.pos.x - CAM.pos.x, vy = (tgy + 0.62) - CAM.pos.y, vz = t.pos.z - CAM.pos.z;
    var along = vx * CAM.dir.x + vy * CAM.dir.y + vz * CAM.dir.z;
    var out = { hits: hits, perShot: +((before - t.hp) / 12).toFixed(2),
                camBehind: +Math.hypot(CAM.pos.x - p.pos.x, CAM.pos.z - p.pos.z).toFixed(2),
                reticleMiss: +Math.sqrt(Math.max(0, (vx * vx + vy * vy + vz * vz) - along * along)).toFixed(3),
                spread: +spread0.toFixed(2) };
    t.hp = 1e9;
    return out;
  })()`);
  console.log('  real third-person camera: ' + JSON.stringify(proper));
  check('aiming from the real third-person camera hits at 70 m', proper.hits >= 10,
    proper.hits + '/12 hits, ' + proper.perShot + ' dmg per shot, crosshair ' + proper.reticleMiss +
    ' m off the chest, ' + proper.spread + ' deg spread');
};
