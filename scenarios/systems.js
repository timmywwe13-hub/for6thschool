// Systems scenario: armour tiers, frag grenades, supply crates, death drops and
// crosshair bloom - the combat-support systems not covered elsewhere.
module.exports = async function systems(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1000);

  const setup = await evaluate(`(function () {
    window.__st = { target: BOTS[0], spot: null };
    Bots.update = function () {
      entityGrid.clear();
      if (Player.alive) entityGrid.insert(Player.pos.x, Player.pos.z, Player);
      for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) entityGrid.insert(BOTS[i].pos.x, BOTS[i].pos.z, BOTS[i]);
      BotView.flush();
    };
    for (var i = 1; i < BOTS.length; i++) { BOTS[i].alive = false; BotView.hide(BOTS[i].index); }
    var t = window.__st.target;
    t.alive = true; t.hp = 1e9; t.shield = 0; t.helmetTier = 0; t.vestTier = 0;
    BotView.flush();
    var spots = World.lootPoints;
    for (var i = 0; i < spots.length && !window.__st.spot; i++) {
      var s = spots[i], h = World.heightAt(s.x, s.z);
      if (h < 3 || h > 26) continue;
      Player.pos.set(s.x, h, s.z);
      Player.yaw = 0; Player.ads = true; Player.crouching = false;
      CAM.yaw = 0; CAM.pitch = 0; Player.camReach = CONFIG.CAM_DIST;
      for (var k = 0; k < 8; k++) Player.updateCamera(0.05);
      var ok = true;
      for (var d = 3; d <= 40 && ok; d += 6) {
        var ty = World.heightAt(s.x, s.z - d) + 0.62;
        if (!World.losClear(CAM.pos.x, CAM.pos.y, CAM.pos.z, s.x, ty, s.z - d)) ok = false;
      }
      if (ok) window.__st.spot = { x: s.x, z: s.z, y: h };
    }
    if (!window.__st.spot) return { err: 'no spot' };
    var p = Player;
    p.pos.set(window.__st.spot.x, window.__st.spot.y, window.__st.spot.z);
    p.vel.set(0, 0, 0); p.grounded = true; p.airborne = false; p.alive = true; p.hp = 100;
    return { spot: window.__st.spot };
  })()`);
  check('systems sandbox ready', !setup.err, setup.err || JSON.stringify(setup.spot));
  if (setup.err) return;

  await evaluate(`(function () {
    window.__stAim = function (dist, aimHead) {
      var p = Player, t = window.__st.target, spot = window.__st.spot;
      p.pos.set(spot.x, spot.y, spot.z);
      var tz = spot.z - dist, tgy = World.heightAt(spot.x, tz);
      t.pos.set(spot.x, tgy, tz);
      t.vel.set(0, 0, 0);
      entityGrid.clear();
      entityGrid.insert(p.pos.x, p.pos.z, p);
      entityGrid.insert(t.pos.x, t.pos.z, t);
      p.ads = true; p.adsT = 1; p.crouching = false;
      Player.yaw = 0;
      CAM.yaw = 0; CAM.pitch = 0;
      Player.camReach = CONFIG.CAM_DIST;
      /* the camera goes where the game puts it, then we aim from there */
      for (var k = 0; k < 8; k++) Player.updateCamera(0.05);
      var ty2 = tgy + (aimHead ? 1.34 : 0.62);
      var dx = t.pos.x - CAM.pos.x, dy = ty2 - CAM.pos.y, dz = t.pos.z - CAM.pos.z;
      CAM.yaw = Math.atan2(dx, -dz);
      CAM.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      Player.yaw = CAM.yaw;
      CAM.sync();
      return t;
    };
    window.__stShoot = function (id, dist, shots) {
      var p = Player, t = window.__st.target;
      p.weapons = [null, null, null, null, null];
      p.curSlot = 0; p.reloadT = 0; p.nextShotT = 0; p.spreadExtra = 0;
      p.ammoReserve = { light: 500, medium: 500, heavy: 500, shells: 500, rockets: 50 };
      p.addWeapon(id);
      window.__stAim(dist, false);
      var before = t.hp;
      for (var i = 0; i < shots; i++) {
        p.weapons[0].mag = CONFIG.WEAPONS[id].mag;
        p.spreadExtra = 0;
        p.shootOne();
      }
      var dealt = before - t.hp;
      t.hp = 1e9;
      return +(dealt / shots).toFixed(2);
    };
    return 'ok';
  })()`);

  /* ---------------- armour tiers reduce bullet damage ---------------- */
  const armour = await evaluate(`(function () {
    var t = window.__st.target;
    t.helmetTier = 0; t.vestTier = 0; t.shield = 0;
    var bare = window.__stShoot('ar', 3, 10);
    t.helmetTier = 1; t.vestTier = 1;
    var lvl1 = window.__stShoot('ar', 3, 10);
    t.helmetTier = 3; t.vestTier = 3;
    var lvl3 = window.__stShoot('ar', 3, 10);
    t.vestTier = 0;
    var helmOnly = window.__stShoot('ar', 3, 10);
    t.helmetTier = 0;
    return { bare: bare, lvl1: lvl1, lvl3: lvl3, helmOnly: helmOnly };
  })()`);
  console.log('  armour: ' + JSON.stringify(armour));
  check('level 1 armour reduces damage', armour.lvl1 < armour.bare,
    armour.bare + ' -> ' + armour.lvl1);
  check('level 3 armour reduces it further', armour.lvl3 < armour.lvl1,
    armour.lvl1 + ' -> ' + armour.lvl3);
  check('full armour cuts damage by roughly half', armour.lvl3 < armour.bare * 0.6,
    'to ' + Math.round(armour.lvl3 / armour.bare * 100) + '% of base');
  check('a helmet on its own helps', armour.helmOnly < armour.bare,
    armour.bare + ' -> ' + armour.helmOnly);

  /* ---------------- shield absorbs before health ---------------- */
  const shield = await evaluate(`(function () {
    var t = window.__st.target;
    t.shield = 100; t.helmetTier = 0; t.vestTier = 0;
    Player.weapons = [{ id: 'ar', mag: 30 }];
    Player.curSlot = 0; Player.spreadExtra = 0; Player.nextShotT = 0;
    window.__stAim(3, false);
    var hp0 = t.hp, sh0 = t.shield;
    Player.shootOne();
    var out = { hpLost: +(hp0 - t.hp).toFixed(1), shieldLost: +(sh0 - t.shield).toFixed(1) };
    t.shield = 0; t.hp = 1e9;
    return out;
  })()`);
  console.log('  shield: ' + JSON.stringify(shield));
  check('shield soaks damage before health', shield.shieldLost > 0 && shield.hpLost === 0,
    JSON.stringify(shield));

  /* ---------------- frag grenade: flight then detonation ---------------- */
  const nade = await evaluate(`(function () {
    var p = Player, t = window.__st.target;
    window.__stAim(7, false);
    p.weapons = [{ id: 'pistol', mag: 15 }];
    p.inv.nade = 1;
    var blast = null;
    var origDet = Projectiles.detonate.bind(Projectiles);
    Projectiles.detonate = function (pp) {
      blast = { x: pp.x, y: pp.y, z: pp.z, t: +pp.t.toFixed(2), kind: pp.kind };
      return origDet(pp);
    };
    var hp0 = t.hp;
    p.throwGrenade();
    var flying = Projectiles.count;
    var steps = 0, maxD = 0;
    for (var i = 0; i < 400; i++) {
      Projectiles.update(0.02);
      entityGrid.insert(t.pos.x, t.pos.z, t);
      steps++;
      if (t.hp !== hp0) break;
    }
    Projectiles.detonate = origDet;
    var out = { flying: flying, steps: steps, dealt: +(hp0 - t.hp).toFixed(1),
                nades: p.inv.nade, after: Projectiles.count, blast: blast };
    if (blast) {
      out.blastDist = +Math.sqrt(Math.pow(blast.x - t.pos.x, 2) + Math.pow(blast.z - t.pos.z, 2)).toFixed(1);
    }
    t.hp = 1e9;
    return out;
  })()`);
  console.log('  grenade: ' + JSON.stringify(nade));
  check('throwing a frag consumes it and puts a projectile in the air',
    nade.flying > 0 && nade.nades === 0, JSON.stringify(nade));
  check('the frag detonates and damages a nearby target', nade.dealt > 0,
    nade.dealt + ' damage after ' + nade.steps + ' steps');
  check('the projectile is recycled after it detonates', nade.after === 0, nade.after);

  /* ---------------- supply crate: parachutes in and coughs up top-tier loot --------- */
  const crate = await evaluate(`(function () {
    var items0 = Loot.count;
    var ang = Math.random() * 6.28;
    var x = window.__st.spot.x + Math.cos(ang) * 30;
    var z = window.__st.spot.z + Math.sin(ang) * 30;
    var c = Loot.spawnCrate(x, z);
    if (!c) return { err: 'crate pool empty' };
    var startedHigh = c.y > 50, steps = 0;
    for (var i = 0; i < 4000 && !c.landed; i++) { Loot.updateCrates(0.05); steps++; }
    return { startedHigh: startedHigh, landed: c.landed, steps: steps,
             items0: items0, items1: Loot.count, y: +c.y.toFixed(1) };
  })()`);
  console.log('  supply crate: ' + JSON.stringify(crate));
  check('a supply crate starts high and parachutes down', crate.startedHigh === true,
    'flying=' + crate.startedHigh);
  check('the crate lands', crate.landed === true, crate.steps + ' steps, y=' + crate.y);
  check('landing a crate drops loot around it', crate.items1 > crate.items0,
    crate.items0 + ' -> ' + crate.items1 + ' items');

  /* ---------------- crosshair bloom follows the spread ---------------- */
  const bloom = await evaluate(`(function () {
    var t = document.getElementById('crosshair').querySelector('.ch-t');
    /* crosshair bloom only updates while the match is live, and the match now
       opens on the bus, so ride and jump first */
    if (App.state === 'BUS') {
      for (var b = 0; b < 3000 && App.state === 'BUS' &&
           Math.hypot(Bus.pos.x, Bus.pos.z) > 290; b++) Bus.update(1 / 60);
      Bus.jump();
    }
    for (var d = 0; d < 600 && App.state === 'DROP'; d++) Game.update(0.05);
    Player.weapons = [{ id: 'smg', mag: 32 }];
    Player.curSlot = 0; Player.reloadT = 0; Player.nextShotT = 0;
    Player.spreadExtra = 0; Player.ads = false; Player.vel.set(0, 0, 0);
    Input.ads = false;
    Game.update(0.016);
    var tight = t.style.transform;
    Player.spreadExtra = 4.5;
    Game.update(0.016);
    var wide = t.style.transform;
    Player.spreadExtra = 0;
    /* aim the way the game really aims: through Input.ads, so Player.update ramps
       adsT and UI.update reads a settled value */
    Input.ads = true;
    for (var a = 0; a < 40; a++) Game.update(0.016);
    var ads = t.style.transform;
    Input.ads = false; Player.ads = false;
    var px = function (s) { var m = /(-?[0-9.]+)px/.exec(s); return m ? +m[1] : 0; };
    return { tight: tight, wide: wide, ads: ads,
             tightGap: -px(tight), wideGap: -px(wide), adsGap: -px(ads) };
  })()`);
  console.log('  crosshair: ' + JSON.stringify(bloom));
  check('the crosshair opens up as spread grows', bloom.wideGap > bloom.tightGap,
    bloom.tightGap + 'px -> ' + bloom.wideGap + 'px');
  check('aiming tightens the crosshair again', bloom.adsGap < bloom.tightGap,
    bloom.adsGap + 'px aimed vs ' + bloom.tightGap + 'px hip');

  /* ---------------- kill feed + death drops ---------------- */
  const feed = await evaluate(`(function () {
    UI.clearFeed();
    var loot0 = Loot.count;
    var victim = window.__st.target;
    if (!victim) return { err: 'no victim' };
    /* bots now start empty handed and loot for gear, so give the victim the
       sort of kit a real one would have by the time it dies */
    victim.weapons = [{ id: 'smg', mag: 21 }, { id: 'pistol', mag: 7 }];
    victim.weaponId = 'smg';
    victim.mag = 21;
    victim.ammoReserve.light = 60;
    victim.inv.bandage = 2;
    victim.inv.medkit = 1;
    victim.helmetTier = 2;
    victim.vestTier = 1;
    victim.hp = 5;
    victim.shield = 0;
    Hit.damage(victim, 999, { attacker: Player, weapon: 'RANGER AR', head: true });
    var rows = document.getElementById('killfeed').querySelectorAll('.kf');
    return {
      rows: rows.length,
      text: rows.length ? rows[0].textContent : '',
      mine: rows.length ? rows[0].className.indexOf('mine') !== -1 : false,
      loot0: loot0, loot1: Loot.count, victimAlive: victim.alive, placement: victim.placement
    };
  })()`);
  console.log('  kill feed: ' + JSON.stringify(feed));
  check('a kill posts a kill-feed row', feed.rows === 1, feed.text);
  check('the row marks your own kill and the headshot',
    feed.mine === true && /HS/.test(feed.text), feed.text);
  check('the victim drops lootable gear', feed.loot1 > feed.loot0,
    feed.loot0 + ' -> ' + feed.loot1 + ' items');
  check('the victim is marked dead with a placement',
    feed.victimAlive === false && feed.placement > 0, '#' + feed.placement);
};
