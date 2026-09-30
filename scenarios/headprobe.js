// Focused probe: a headshot at close range under third-person convergence.
module.exports = async function headprobe(ctx) {
  const { evaluate, check, sleep } = ctx;
  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1000);

  const out = await evaluate(`(function () {
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
      Player.pos.set(s.x, h, s.z);
      Player.yaw = 0; Player.ads = true; Player.crouching = false;
      CAM.yaw = 0; CAM.pitch = 0; Player.camReach = CONFIG.CAM_DIST;
      for (var k = 0; k < 8; k++) Player.updateCamera(0.05);
      var ok = true;
      for (var d = 3; d <= 12 && ok; d += 3) {
        if (!World.losClear(CAM.pos.x, CAM.pos.y, CAM.pos.z, s.x, World.heightAt(s.x, s.z - d) + 1.34, s.z - d)) ok = false;
      }
      if (ok) spot = { x: s.x, z: s.z, y: h };
    }
    if (!spot) return { err: 'no spot' };

    var dist = 4;
    var p = Player;
    p.weapons = [{ id: 'ar', mag: 30 }]; p.curSlot = 0;
    p.reloadT = 0; p.nextShotT = 0; p.spreadExtra = 0; p.ads = true; p.adsT = 1;
    p.ammoReserve.medium = 300;
    p.pos.set(spot.x, spot.y, spot.z);
    p.yaw = 0;
    var tz = spot.z - dist, tgy = World.heightAt(spot.x, tz);
    t.pos.set(spot.x, tgy, tz);
    entityGrid.clear();
    entityGrid.insert(p.pos.x, p.pos.z, p);
    entityGrid.insert(t.pos.x, t.pos.z, t);
    CAM.yaw = 0; CAM.pitch = 0; p.camReach = CONFIG.CAM_DIST;
    for (var k = 0; k < 8; k++) p.updateCamera(0.05);
    var headY = tgy + 1.34, chestY = tgy + 0.62;
    /* aim the camera at a world point: BOTH yaw and pitch, because the camera
       sits off-axis from the player (over the shoulder) */
    var aimAt = function (x, y, z) {
      var dx = x - CAM.pos.x, dy = y - CAM.pos.y, dz = z - CAM.pos.z;
      CAM.yaw = Math.atan2(dx, -dz);
      CAM.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      Player.yaw = CAM.yaw;
      CAM.sync();
    };
    aimAt(t.pos.x, headY, t.pos.z);

    var r = { cam: [+CAM.pos.x.toFixed(2), +CAM.pos.y.toFixed(2), +CAM.pos.z.toFixed(2)],
              camToHead3D: +Math.hypot(t.pos.x - CAM.pos.x, headY - CAM.pos.y, t.pos.z - CAM.pos.z).toFixed(2),
              pitch: +CAM.pitch.toFixed(3), yaw: +CAM.yaw.toFixed(3) };
    var ch = Hit.hitscan(CAM.pos.x, CAM.pos.y, CAM.pos.z, CAM.dir.x, CAM.dir.y, CAM.dir.z, 160, Player);
    r.camHit = { t: +ch.t.toFixed(2), bot: ch.bot ? ch.bot.name : null, head: ch.head, world: ch.world };
    var aimX = CAM.pos.x + CAM.dir.x * ch.t, aimY = CAM.pos.y + CAM.dir.y * ch.t, aimZ = CAM.pos.z + CAM.dir.z * ch.t;
    var fwdX = Math.sin(p.yaw), fwdZ = -Math.cos(p.yaw);
    var rgtX = Math.cos(p.yaw), rgtZ = Math.sin(p.yaw);
    var mx = p.pos.x + fwdX * 0.95 + rgtX * 0.22, my = p.pos.y + 0.99, mz = p.pos.z + fwdZ * 0.95 + rgtZ * 0.22;
    r.muzzle = [+mx.toFixed(2), +my.toFixed(2), +mz.toFixed(2)];
    r.aim = [+aimX.toFixed(2), +aimY.toFixed(2), +aimZ.toFixed(2)];
    r.headSphereCentre = [+t.pos.x.toFixed(2), +headY.toFixed(2), +t.pos.z.toFixed(2)];
    var vx = aimX - mx, vy = aimY - my, vz = aimZ - mz;
    var vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
    r.muzzleToAim = +vl.toFixed(2);
    var mh = Hit.hitscan(mx, my, mz, vx / vl, vy / vl, vz / vl, 160, Player);
    r.muzzleHit = { t: +mh.t.toFixed(2), bot: mh.bot ? mh.bot.name : null, head: mh.head, world: mh.world };
    /* which sphere does the muzzle ray hit first, and where? */
    r.torsoFirstT = +raySphereT(mx, my, mz, vx / vl, vy / vl, vz / vl, t.pos.x, tgy + 0.62, t.pos.z, 0.46).toFixed(2);
    r.headFirstT = +raySphereT(mx, my, mz, vx / vl, vy / vl, vz / vl, t.pos.x, headY, t.pos.z, 0.28).toFixed(2);
    r.camTorsoT = +raySphereT(CAM.pos.x, CAM.pos.y, CAM.pos.z, CAM.dir.x, CAM.dir.y, CAM.dir.z,
                              t.pos.x, tgy + 0.62, t.pos.z, 0.46).toFixed(2);
    r.camHeadT = +raySphereT(CAM.pos.x, CAM.pos.y, CAM.pos.z, CAM.dir.x, CAM.dir.y, CAM.dir.z,
                             t.pos.x, headY, t.pos.z, 0.28).toFixed(2);
    var before = t.hp;
    p.shootOne();
    r.damage = +(before - t.hp).toFixed(1);
    p.shootOne();
    r.damage2 = +(before - t.hp).toFixed(1);
    t.hp = 1e9;
    return r;
  })()`);
  console.log(JSON.stringify(out, null, 1));
  check('probe ran', !out.err, out.err || 'ok');
};
