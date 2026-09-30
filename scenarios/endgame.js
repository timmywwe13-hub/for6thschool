// Endgame probe: drive a match to the last few survivors (spectating after the
// player dies) and dump exactly why the final bots do or do not kill each other.
module.exports = async function endgame(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(800);
  await evaluate(`(function () {
    window.__eg = { dmg: 0, botToBot: 0, shots: 0, sightFound: 0, sightCalls: 0 };
    var P = window.__eg;
    var od = Hit.damage.bind(Hit);
    Hit.damage = function (e, a, o) {
      P.dmg++;
      var at = o && o.attacker;
      if (at && at !== Player && e && e !== Player) P.botToBot++;
      return od(e, a, o);
    };
    var of = Bots.fireAt.bind(Bots);
    Bots.fireAt = function (b, t, d, dt) {
      var m0 = b.mag; of(b, t, d, dt); if (b.mag < m0) P.shots++;
    };
    var os = Bots.checkSight.bind(Bots);
    Bots.checkSight = function (b, dt) { P.sightCalls++; var r = os(b, dt); if (r) P.sightFound++; return r; };
    return 'ok';
  })()`);

  const ff = (seconds, dt) => evaluate(`(function () {
    var steps = Math.round(${seconds} / ${dt});
    for (var i = 0; i < steps; i++) {
      if (App.state === 'GAME_OVER') break;
      try { Game.update(${dt}); } catch (e) { return { err: e.message }; }
    }
    var alive = [];
    for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) alive.push(BOTS[i].name);
    return { err: null, state: App.state, appAlive: App.aliveCount, botAlive: Bots.aliveCount(),
             names: alive, zone: Zone.state, phase: Zone.phase, r: +Zone.cur.r.toFixed(1),
             dps: Zone.dps(), probe: JSON.parse(JSON.stringify(window.__eg)) };
  })()`);

  /* the player sits still and eventually dies to the storm, so step in 20 s
     chunks and hop into spectate as soon as the death screen appears */
  let r = null, spectated = false;
  for (let i = 0; i < 60; i++) {
    r = await ff(20, 0.05);
    if (r.err) { check('sim ran clean', false, r.err); break; }
    if (r.state === 'GAME_OVER') {
      const isDeath = await evaluate(
        `!document.getElementById('deathScreen').classList.contains('hidden')`);
      if (isDeath && !spectated) {
        await evaluate(`document.getElementById('btnSpectate').click(); 'spec'`);
        spectated = true;
        await sleep(200);
        console.log('    player died at ~' + (i + 1) * 20 + 's - spectating the rest');
        continue;
      }
      console.log('    match ended at ~' + (i + 1) * 20 + 's with ' + r.botAlive + ' bots alive');
      break;
    }
    if (i % 5 === 4) {
      console.log('    +' + (i + 1) * 20 + 's  bots=' + r.botAlive + '  zone=' + r.zone +
        ' phase=' + r.phase + ' r=' + r.r + ' dps=' + r.dps +
        '  botToBot=' + r.probe.botToBot + ' shots=' + r.probe.shots +
        ' sightFound=' + r.probe.sightFound);
    }
    if (r.botAlive <= 3 && r.zone === 'final') break;
  }
  check('match left the DROP phase', r && r.state !== 'DROP' && r.state !== 'BUS',
    r ? r.state : '-');
  console.log('  final: ' + JSON.stringify({ state: r.state, bots: r.botAlive, zone: r.zone,
    phase: r.phase, r: r.r, probe: r.probe }));

  const dump = await evaluate(`(function () {
    var out = [];
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (!b.alive) continue;
      out.push({
        name: b.name, state: b.state, stateT: +b.stateT.toFixed(1),
        hp: Math.round(b.hp), sh: Math.round(b.shield), wp: b.weaponId, mag: b.mag,
        ammo: b.ammoReserve, x: +b.pos.x.toFixed(1), z: +b.pos.z.toFixed(1), y: +b.pos.y.toFixed(1),
        target: b.target ? b.target.name : null, seen: b.hasSeen,
        relT: +b.reloadT.toFixed(2), fireT: +b.fireT.toFixed(2), burst: b.burstLeft,
        outBy: +Zone.outsideBy(b.pos.x, b.pos.z).toFixed(1)
      });
    }
    var pair = null;
    if (out.length === 2) {
      var a = BOTS.filter(function (b) { return b.alive; })[0];
      var c = BOTS.filter(function (b) { return b.alive; })[1];
      pair = {
        dist: +dist2D(a.pos.x, a.pos.z, c.pos.x, c.pos.z).toFixed(2),
        losAC: World.losClear(a.pos.x, a.pos.y + 1.45, a.pos.z, c.pos.x, c.pos.y + 1.1, c.pos.z),
        losCA: World.losClear(c.pos.x, c.pos.y + 1.45, c.pos.z, a.pos.x, a.pos.y + 1.1, a.pos.z),
        nearestA: (Bots.nearestEnemy(a, 120) || {}).name || null,
        nearestC: (Bots.nearestEnemy(c, 120) || {}).name || null,
        sightA: (Bots.checkSight(a, 0.1) || {}).name || null,
        sightC: (Bots.checkSight(c, 0.1) || {}).name || null
      };
    }
    return { alive: out, pair: pair, zone: { st: Zone.state, phase: Zone.phase, r: Zone.cur.r,
             x: Zone.cur.x, z: Zone.cur.z }, probe: window.__eg };
  })()`);
  console.log('  ENDGAME: ' + JSON.stringify(dump, null, 1).slice(0, 2600));
};
