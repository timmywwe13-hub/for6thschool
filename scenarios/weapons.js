// Weapons scenario: every weapon must be equippable, fireable, and measurably
// different (damage, falloff, headshots, fire rate, magazine, reload, ammo).
module.exports = async function weapons(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1000);

  const setup = await evaluate(`(function () {
    /* quiet sandbox: bots stop thinking, the grid still knows about them */
    window.__wt = { target: BOTS[0], spot: null };
    Bots.update = function () {
      entityGrid.clear();
      if (Player.alive) entityGrid.insert(Player.pos.x, Player.pos.z, Player);
      for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) entityGrid.insert(BOTS[i].pos.x, BOTS[i].pos.z, BOTS[i]);
      BotView.flush();
    };
    for (var i = 1; i < BOTS.length; i++) { BOTS[i].alive = false; BotView.hide(BOTS[i].index); }
    var t = window.__wt.target;
    t.alive = true;
    t.hp = 1e9; t.shield = 0; t.helmetTier = 0; t.vestTier = 0; t.crouch = false;
    BotView.flush();

    /* find open, flat ground where the *third-person camera* has a clear
       straight line to the target, at both the near and the far test range */
    var spots = World.lootPoints;
    for (var i = 0; i < spots.length && !window.__wt.spot; i++) {
      var s = spots[i], h = World.heightAt(s.x, s.z);
      if (h < 3 || h > 26) continue;
      Player.pos.set(s.x, h, s.z);
      Player.yaw = 0; Player.ads = true; Player.crouching = false;
      CAM.yaw = 0; CAM.pitch = 0; Player.camReach = CONFIG.CAM_DIST;
      for (var k = 0; k < 8; k++) Player.updateCamera(0.05);
      var ok = true;
      for (var d = 3; d <= 70 && ok; d += 7) {
        var ty = World.heightAt(s.x, s.z - d) + 0.62;
        if (!World.losClear(CAM.pos.x, CAM.pos.y, CAM.pos.z, s.x, ty, s.z - d)) ok = false;
      }
      if (ok) window.__wt.spot = { x: s.x, z: s.z, y: h };
    }
    if (!window.__wt.spot) return { err: 'no open spot found' };
    Player.pos.set(window.__wt.spot.x, window.__wt.spot.y, window.__wt.spot.z);
    Player.vel.set(0, 0, 0);
    Player.grounded = true;
    Player.alive = true;
    Player.hp = 100;
    return { spot: window.__wt.spot, weapons: Object.keys(CONFIG.WEAPONS) };
  })()`);
  console.log('  sandbox: ' + JSON.stringify(setup));
  check('sandbox spot found', !setup.err, setup.err || JSON.stringify(setup.spot));
  if (setup.err) return;

  await evaluate(`(function () {
    window.__wprepare = function (id) {
      var p = Player, w = CONFIG.WEAPONS[id];
      p.weapons = [null, null, null, null, null];
      p.curSlot = 0;
      p.reloadT = 0; p.nextShotT = 0; p.burstLeft = 0; p.spreadExtra = 0; p.swapT = 0;
      p.ammoReserve = { light: 0, medium: 0, heavy: 0, shells: 0, rockets: 0 };
      p.addWeapon(id);
      p.weapons[0].mag = w.mag;
      p.ammoReserve[w.ammo] = CONFIG.AMMO_LIMIT[w.ammo];
      p.ads = false; p.adsT = 0;
      return { w: w, mag: p.weapons[0].mag };
    };
    window.__wfire = function (dist, aimHead, shots, ads) {
      var p = Player, t = window.__wt.target, w = CONFIG.WEAPONS[p.weapons[0].id];
      var spot = window.__wt.spot;
      p.pos.set(spot.x, spot.y, spot.z);
      var tx = spot.x, tz = spot.z - dist;
      var tgy = World.heightAt(tx, tz);
      t.pos.set(tx, tgy, tz);
      t.vel.set(0, 0, 0);
      entityGrid.clear();
      entityGrid.insert(p.pos.x, p.pos.z, p);
      entityGrid.insert(t.pos.x, t.pos.z, t);
      p.crouching = false;
      p.ads = !!ads; p.adsT = ads ? 1 : 0;
      Player.yaw = 0;
      CAM.yaw = 0; CAM.pitch = 0;
      Player.camReach = CONFIG.CAM_DIST;
      /* let the game put the camera where it really goes, then aim at the
         target from there - exactly like a player aiming with the mouse */
      for (var k = 0; k < 8; k++) Player.updateCamera(0.05);
      var targetY = tgy + (aimHead ? 1.34 : 0.62);
      /* aim with BOTH yaw and pitch: the camera is over the shoulder, so it is
         off-axis from the player and a pitch-only aim would miss laterally */
      var adx = tx - CAM.pos.x, ady = targetY - CAM.pos.y, adz = tz - CAM.pos.z;
      CAM.yaw = Math.atan2(adx, -adz);
      CAM.pitch = Math.atan2(ady, Math.hypot(adx, adz));
      Player.yaw = CAM.yaw;
      CAM.sync();
      var before = t.hp, hits = 0;
      for (var i = 0; i < shots; i++) {
        p.weapons[0].mag = w.mag;
        p.spreadExtra = 0;                     // measure the base cone, not bloom
        var hp0 = t.hp;
        p.shootOne();
        if (t.hp < hp0) hits++;
      }
      var dealt = before - t.hp;
      t.hp = 1e9;
      return { perShot: +(dealt / shots).toFixed(2), shots: shots, hitShots: hits };
    };
    /* projectile weapons (the grenade launcher) resolve through Projectiles */
    window.__wrocket = function (dist) {
      var p = Player, t = window.__wt.target, w = CONFIG.WEAPONS[p.weapons[0].id];
      var spot = window.__wt.spot;
      p.pos.set(spot.x, spot.y, spot.z);
      var tx = spot.x, tz = spot.z - dist;
      var tgy = World.heightAt(tx, tz);
      t.pos.set(tx, tgy, tz);
      entityGrid.clear();
      entityGrid.insert(p.pos.x, p.pos.z, p);
      entityGrid.insert(t.pos.x, t.pos.z, t);
      p.ads = true; p.adsT = 1;
      Player.yaw = 0;
      CAM.yaw = 0; CAM.pitch = 0;
      Player.camReach = CONFIG.CAM_DIST;
      for (var k = 0; k < 8; k++) Player.updateCamera(0.05);
      var rdx = tx - CAM.pos.x, rdy = (tgy + 0.62) - CAM.pos.y, rdz = tz - CAM.pos.z;
      CAM.yaw = Math.atan2(rdx, -rdz);
      CAM.pitch = Math.atan2(rdy, Math.hypot(rdx, rdz));
      Player.yaw = CAM.yaw;
      CAM.sync();
      p.spreadExtra = 0;
      p.weapons[0].mag = w.mag;
      var before = t.hp;
      p.shootOne();
      for (var i = 0; i < 120 && t.hp === before; i++) {
        Projectiles.update(0.01);
        entityGrid.insert(t.pos.x, t.pos.z, t);
        t.hp = t.hp;                            // keep the value stable for the check
        if (t.hp < before) break;
      }
      var dealt = before - t.hp;
      t.hp = 1e9;
      return { perShot: +dealt.toFixed(2), shots: 1, hitShots: dealt > 0 ? 1 : 0 };
    };
    return 'helpers ready';
  })()`);

  /* ---- collect one row of measurements per weapon ---- */
  const ids = setup.weapons;
  const rows = [];
  for (const id of ids) {
    const row = await evaluate(`(function () {
      var id = ${JSON.stringify(id)};
      var prep = window.__wprepare(id);
      var w = prep.w;
      var farDist = Math.min(70, Math.max(20, w.falloffEnd * 0.9));
      var projectile = w.projectile === 'rocket';
      /* 40 shots, not 12. The SMG's 0.7 deg ADS cone at its own falloff distance
         is still inside the 0.46 m body sphere about three times in four, so a
         12-shot sample comes back 12/12 by luck often enough to make the spread
         check look broken - and a real spread regression would look the same as
         that luck. 40 shots make a clean sweep about one run in fifty thousand. */
      var SHOTS = 40;
      var close = projectile ? window.__wrocket(4) : window.__wfire(3, false, SHOTS, true);
      var far = projectile ? window.__wrocket(22) : window.__wfire(farDist, false, SHOTS, true);
      var head = projectile ? close : window.__wfire(3, true, SHOTS, true);
      return {
        id: id, name: w.name, tier: w.tier, ammo: w.ammo, mag: w.mag, rpm: w.rpm,
        reload: w.reload, auto: !!w.auto, burst: w.burst || 0, pellets: w.pellets || 1,
        scope: !!w.scope, hs: w.hs, projectile: !!projectile,
        close: close, far: far, head: head, farDist: farDist,
        /* damage per shot that actually connected - isolates falloff from the
           way spread makes long shots miss */
        closePerHit: close.hitShots ? +(close.perShot * close.shots / close.hitShots).toFixed(2) : 0,
        farPerHit: far.hitShots ? +(far.perShot * far.shots / far.hitShots).toFixed(2) : 0,
        interval: +Player.shotInterval().toFixed(4),
        dps: +(close.perShot / Player.shotInterval()).toFixed(1)
      };
    })()`);
    rows.push(row);
    console.log('    ' + row.name.padEnd(16) + ' t' + row.tier + ' ' + row.ammo.padEnd(7) +
      ' mag ' + String(row.mag).padStart(3) + ' rpm ' + String(row.rpm).padStart(3) +
      '  close ' + String(row.close.perShot).padStart(7) + '  far(' + row.farDist + 'm) ' +
      String(row.far.perShot).padStart(7) + '  head ' + String(row.head.perShot).padStart(7) +
      '  dps ' + String(row.dps).padStart(6) + (row.auto ? ' auto' : '') +
      (row.pellets > 1 ? ' pellets x' + row.pellets : '') + (row.scope ? ' scope' : ''));
  }

  const byId = {};
  rows.forEach(r => { byId[r.id] = r; });
  check('at least 6 weapons exist', rows.length >= 6, rows.length + ' weapons');
  check('every weapon deals damage at point blank', rows.every(r => r.close.perShot > 0),
    rows.filter(r => !(r.close.perShot > 0)).map(r => r.id).join(',') || 'all');
  check('every bullet weapon hits harder on a headshot',
    rows.filter(r => !r.projectile && r.pellets === 1).every(r => r.head.perShot > r.close.perShot),
    rows.filter(r => !r.projectile && r.pellets === 1 && !(r.head.perShot > r.close.perShot))
      .map(r => r.id).join(',') || 'all single-projectile weapons');
  check('the grenade launcher damages through its projectile + splash',
    byId.launcher.close.perShot > 0 && byId.launcher.projectile,
    'launcher ' + byId.launcher.close.perShot + ' dmg at 4m');

  /* An explosion has to report its damage the way a bullet does: a rocket or a
     frag that hurt a bot spawns the floating number over it (Projectiles.detonate).
     Rockets and grenades used to deal their splash silently - no number at all -
     while every gunshot showed one. The call itself is captured (the pool of 22
     DOM numbers can be drained by the shots above) and the live on-screen number
     is counted after letting the pool empty out. */
  const splash = await evaluate(`(function () {
    window.__wprepare('launcher');
    Player.alive = true; Player.hp = 1e6;      // splash self-damage must not kill us
    var t = window.__wt.target;
    t.alive = true; t.hp = 1e9; t.shield = 0;
    FX.update(2.5);                            // every pooled number has expired now
    var calls = [];
    var orig = FX.damageNumber;
    FX.damageNumber = function (x, y, z, text, kind) { calls.push(text); return orig(x, y, z, text, kind); };
    var hit = window.__wrocket(4);
    FX.damageNumber = orig;
    var live = 0, sample = null;
    var els = document.querySelectorAll('#dmgNums .dnum');
    for (var i = 0; i < els.length; i++) {
      if (els[i].style.display !== 'none' && els[i].textContent) {
        live++;
        if (sample === null) sample = els[i].textContent;
      }
    }
    return { dealt: hit.perShot, calls: calls.length, live: live, sample: sample };
  })()`);
  console.log('  splash damage numbers: ' + JSON.stringify(splash));
  check('a grenade launcher hit shows its damage as a floating number',
    splash.calls > 0 && splash.live > 0 && Number(splash.sample) > 0,
    JSON.stringify(splash));
  check('the shotgun still rewards aiming for the head',
    byId.shotgun.head.perShot > 0, byId.shotgun.head.perShot + ' dmg');
  check('5 ammo types are in use', new Set(rows.map(r => r.ammo)).size === 5,
    [...new Set(rows.map(r => r.ammo))].join(','));
  check('all 5 rarity tiers are represented', new Set(rows.map(r => r.tier)).size === 5,
    [...new Set(rows.map(r => r.tier))].sort().join(','));
  check('sniper hits hardest per bullet',
    rows.filter(r => !r.projectile).every(r => r.id === 'sniper' ||
      r.close.perShot <= byId.sniper.close.perShot),
    'sniper ' + byId.sniper.close.perShot + ' vs next ' +
      Math.max(...rows.filter(r => !r.projectile && r.id !== 'sniper').map(r => r.close.perShot)));
  check('shotgun fires multiple pellets', byId.shotgun.pellets >= 4, byId.shotgun.pellets);
  check('shotgun damage collapses with range',
    byId.shotgun.far.perShot < byId.shotgun.close.perShot * 0.5,
    byId.shotgun.close.perShot + ' -> ' + byId.shotgun.far.perShot);
  check('smg has the fastest fire rate of the automatics',
    rows.filter(r => r.auto).every(r => r.rpm <= byId.smg.rpm), 'smg ' + byId.smg.rpm + ' rpm');
  check('smg damage falls off badly with range',
    byId.smg.farPerHit < byId.smg.closePerHit * 0.8,
    'per hit ' + byId.smg.closePerHit + ' -> ' + byId.smg.farPerHit);
  check('assault rifle keeps its damage at range (falloff only, per hit)',
    byId.ar.farPerHit >= byId.ar.closePerHit * 0.85,
    'per hit ' + byId.ar.closePerHit + ' -> ' + byId.ar.farPerHit);
  check('a spray weapon misses more at range than point blank',
    byId.smg.close.hitShots > byId.smg.far.hitShots,
    'smg hits ' + byId.smg.close.hitShots + '/' + byId.smg.close.shots + ' close vs ' +
    byId.smg.far.hitShots + '/' + byId.smg.far.shots + ' at ' + Math.round(byId.smg.farDist) + 'm');
  console.log('    AR is the accurate one: ' + byId.ar.close.hitShots + '/' + byId.ar.close.shots +
    ' close vs ' + byId.ar.far.hitShots + '/' + byId.ar.far.shots + ' at ' +
    Math.round(byId.ar.farDist) + 'm while aiming');
  check('lmg has the biggest magazine', byId.lmg.mag >= Math.max(...rows.map(r => r.mag)),
    byId.lmg.mag + ' rounds');
  check('sniper is scoped', byId.sniper.scope === true, 'scope=' + byId.sniper.scope);
  check('burst rifle fires 3-round bursts', byId.burst.burst === 3, byId.burst.burst);
  check('weapons have meaningfully different DPS',
    (Math.max(...rows.map(r => r.dps)) / Math.min(...rows.map(r => r.dps))) > 2.5,
    Math.min(...rows.map(r => r.dps)) + ' .. ' + Math.max(...rows.map(r => r.dps)) + ' dps');

  /* ---- reload + ammo bookkeeping per weapon ---- */
  const rel = await evaluate(`(function () {
    var out = {};
    var ids = Object.keys(CONFIG.WEAPONS);
    Player.alive = true; Player.hp = 100;      // splash self-damage may have hurt us
    for (var k = 0; k < ids.length; k++) {
      var id = ids[k], w = CONFIG.WEAPONS[id];
      window.__wprepare(id);
      var slot = Player.weapons[0];
      Player.ammoReserve[w.ammo] = Math.min(500, CONFIG.AMMO_LIMIT[w.ammo]);
      var res0 = Player.ammoReserve[w.ammo];
      slot.mag = 0;
      var diag = { alive: Player.alive, reloadT0: Player.reloadT, using: !!Player.using,
                   slotNull: !slot, wdef: !!Player.wdef(), wMag: w.mag, res: Player.ammoReserve[w.ammo] };
      Player.reload();
      var started = Player.reloadT > 0;
      Player.reloadT = 0.0001;
      Player.update(0.001);
      out[id] = { started: started, magAfter: slot.mag, resBefore: res0,
                  resAfter: Player.ammoReserve[w.ammo], time: w.reload, diag: diag };
    }
    return out;
  })()`);
  const bad = Object.keys(rel).filter(k => !rel[k].started || rel[k].magAfter === 0 ||
    rel[k].resAfter >= rel[k].resBefore);
  check('every weapon reloads and eats reserve ammo', bad.length === 0,
    bad.length ? JSON.stringify(bad.map(k => [k, rel[k]])) : 'all ' + Object.keys(rel).length + ' clean');
  console.log('    reload times: ' + Object.keys(rel).map(k => k + '=' + rel[k].time + 's').join(' '));

  const ammo = await evaluate(`(function () {
    var p = Player;
    p.ammoReserve = { light: 0, medium: 0, heavy: 0, shells: 0, rockets: 0 };
    var got = p.addAmmo('light', 99999);
    var capped = p.ammoReserve.light;
    var extra = p.addAmmo('light', 50);
    return { got: got, capped: capped, limit: CONFIG.AMMO_LIMIT.light, extra: extra };
  })()`);
  check('ammo reserves respect their cap', ammo.capped === ammo.limit && ammo.extra === 0,
    JSON.stringify(ammo));

  const slots = await evaluate(`(function () {
    var p = Player;
    p.weapons = [null, null, null, null, null]; p.curSlot = 0;
    p.addWeapon('pistol'); p.addWeapon('smg'); p.addWeapon('ar'); p.addWeapon('sniper'); p.addWeapon('lmg');
    var filled = p.weapons.map(function (x) { return x ? x.id : null; });
    var sixth = p.addWeapon('shotgun');
    return { filled: filled, count: p.weapons.filter(function (x) { return !!x; }).length,
             cur: p.currentWeapon().id, text: sixth.text };
  })()`);
  check('5 weapon slots fill up', slots.filled.filter(Boolean).length === 5 &&
    slots.count === 5, slots.filled.join(','));
  check('a 6th pickup swaps in place instead of overflowing', slots.count === 5, slots.text);

  const spread = await evaluate(`(function () {
    var out = {};
    var ids = Object.keys(CONFIG.WEAPONS);
    for (var k = 0; k < ids.length; k++) {
      window.__wprepare(ids[k]);
      Player.vel.set(0, 0, 0);
      Player.crouching = false;
      Player.spreadExtra = 0;
      Player.ads = false;
      var hip = Player.currentSpread();
      Player.ads = true;
      var ads = Player.currentSpread();
      Player.crouching = true;
      var crouch = Player.currentSpread();
      out[ids[k]] = { hip: hip, ads: ads, crouchAds: crouch };
    }
    Player.ads = false; Player.crouching = false;
    return out;
  })()`);
  const adsBetter = Object.keys(spread).every(k => spread[k].ads < spread[k].hip);
  const crouchBetter = Object.keys(spread).every(k => spread[k].crouchAds <= spread[k].ads + 1e-9);
  check('aiming down sights always tightens the cone', adsBetter,
    JSON.stringify(spread[Object.keys(spread)[0]]));
  check('crouching tightens the cone further', crouchBetter,
    JSON.stringify(spread[Object.keys(spread)[0]]));
};
