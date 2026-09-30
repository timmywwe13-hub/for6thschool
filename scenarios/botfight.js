// Fight probe: is combat actually happening? Counts engagement attempts, the
// new line-of-sight rejections, shots and kills over a real match slice.
module.exports = async function botfight(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1200);

  const inst = await evaluate(`(function () {
    window.__f = { fireAt: 0, losBlocked: 0, shots: 0, dmg: 0, engages: 0, sights: 0, seen: 0 };
    var P = window.__f;
    var of = Bots.fireAt.bind(Bots);
    Bots.fireAt = function (b, t, d, dt) {
      P.fireAt++;
      var m0 = b.mag;
      var mx = b.pos.x + Math.sin(b.yaw) * 0.65, mz = b.pos.z - Math.cos(b.yaw) * 0.65;
      var my = b.pos.y + (b.crouch ? 1.05 : 1.3);
      var clear = World.losClear(mx, my, mz, t.pos.x, t.pos.y + 1.0, t.pos.z);
      of(b, t, d, dt);
      if (b.mag < m0) P.shots++;
      else if (!clear && b.mag === m0) P.losBlocked++;
    };
    var od = Hit.damage.bind(Hit);
    Hit.damage = function (e, a, o) { if (o && o.attacker) P.dmg++; return od(e, a, o); };
    var os = Bots.checkSight.bind(Bots);
    Bots.checkSight = function (b, dt, r) { P.sights++; var v = os(b, dt, r); if (v) P.seen++; return v; };
    var ost = Bots.step.bind(Bots);
    Bots.step = function (b, dt) { var s0 = b.state; ost(b, dt); if (s0 !== 'engage' && b.state === 'engage') P.engages++; };
    return 'ok';
  })()`);
  check('probe installed', inst === 'ok', inst);

  const report = await evaluate(`(function () {
    /* Guns only come out of chests now, so the lobby takes longer to arm itself
       and the fight takes longer to start: this runs two minutes of ground time
       rather than seventy seconds, which is what makes the kill count a signal
       instead of a coin toss between seeds. */
    if (App.state === 'BUS') {
      for (var b0 = 0; b0 < 3000 && App.state === 'BUS' &&
           Math.hypot(Bus.pos.x, Bus.pos.z) > 290; b0++) Bus.update(1 / 60);
      Bus.jump();
    }
    for (var i = 0; i < 2800; i++) {
      if (App.state === 'GAME_OVER') break;
      Game.update(0.05);
      Player.hp = 1e9; Player.alive = true;
    }
    var states = {}, armed = 0, alive = 0, s = '';
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (!b.alive) continue;
      alive++;
      states[b.state] = (states[b.state] || 0) + 1;
      if (b.weaponId) armed++;
    }
    /* how close are armed bots to their nearest enemy right now? */
    var dists = [];
    for (var i = 0; i < BOTS.length; i++) {
      var b2 = BOTS[i];
      if (!b2.alive || !b2.weaponId) continue;
      var near = Bots.nearestEnemy(b2, 400);
      dists.push(near ? Math.round(dist2D(b2.pos.x, b2.pos.z, near.pos.x, near.pos.z)) : 999);
    }
    dists.sort(function (a, b3) { return a - b3; });
    return { t: +App.matchTime.toFixed(0), alive: alive, armed: armed, states: states,
             botKills: BOTS.reduce(function (a, b4) { return a + (b4.kills || 0); }, 0),
             dead: App.totalCombatants - App.aliveCount,
             nearestEnemy: { min: dists[0], median: dists[Math.floor(dists.length / 2)],
                             within60: dists.filter(function (d) { return d < 60; }).length,
                             total: dists.length },
             counter: window.__f };
  })()`);
  console.log('  ' + JSON.stringify(report, null, 1).replace(/\n\s*/g, ' '));
  check('bots are engaging each other', report.counter.engages > 20,
    report.counter.engages + ' engage transitions');
  check('bots are shooting', report.counter.shots > 100, report.counter.shots + ' rounds fired');
  /* Guns live in chests now, so the lobby arms itself a little later than it did
     when guns lay on the ground: by 70 s roughly half the survivors carry a
     weapon (see the `chests` and `botgear` scenarios for the curve). The bar
     here is "the lobby is actually thinning itself out", not the old figure. */
  check('kills are happening', report.botKills > 4, report.botKills + ' bot-vs-bot kills');

  /* where are the guns, and how far is an unarmed bot from one? */
  const gear = await evaluate(`(function () {
    var weapons = 0, total = Loot.count;
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (!b.alive || b.weaponId) continue;
      var near = Loot.nearestWeapon(b.pos.x, b.pos.z, b.pos.y, 500);
      if (near) weapons++;
    }
    /* total guns actually lying in the world */
    var guns = 0;
    var probe = Loot.nearestWeapon(0, 0, World.heightAt(0, 0), 600);
    if (probe) guns++;
    return { lootItems: total, unarmedWithGunIn500m: weapons,
             armed: BOTS.filter(function (b) { return b.alive && b.weaponId; }).length,
             alive: Bots.aliveCount(), t: +App.matchTime.toFixed(0),
             nearSample: probe ? { x: Math.round(probe.x), z: Math.round(probe.z) } : null };
  })()`);
  console.log('  gear: ' + JSON.stringify(gear));
};
