// Full match scenario: drop -> loot -> bots fight -> zone shrinks -> player
// dies, then a second match where the player wins. Also verifies that alive
// counts fall from bot-vs-bot combat and that restart leaves no stale state.
//
// The simulation is fast-forwarded by calling the game's own Game.update()
// with a fixed timestep, so a 10-minute match runs in a few seconds.

function ffChunk(seconds, dt) {
  return `(function () {
    var steps = Math.round(${seconds} / ${dt});
    var i = 0, err = null;
    /* the match opens on the battle bus: ride it out before simulating */
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (; i < steps; i++) {
      if (App.state === 'GAME_OVER') break;
      try { Game.update(${dt}); } catch (e) {
        err = (e && e.message) + ' || ' + String(e && e.stack || '').split('\\n')[1];
        break;
      }
    }
    return {
      steps: i, err: err, state: App.state, alive: App.aliveCount,
      playerAlive: Player.alive, kills: Player.kills, hp: Math.round(Player.hp),
      zonePhase: Zone.phase, zoneState: Zone.state, zoneR: +Zone.cur.r.toFixed(1),
      cap: CONFIG.MATCH_TIME_CAP,
      matchTime: +App.matchTime.toFixed(1), spectating: !!Game.spectating,
      placement: Player.placement, killer: Player.killedBy
    };
  })()`;
}

module.exports = async function fullmatch(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1200);

  const start = await evaluate(`({ state: App.state, alive: App.aliveCount, feed: 0 })`);
  check('match 1 started on the bus', start.state === 'BUS' && start.alive === 100,
    JSON.stringify(start));

  /* --- fast-forward the whole match in 25 s chunks --- */
  const alive = [];
  let last = null, simSeconds = 0;
  for (let i = 0; i < 40 && (!last || last.state !== 'GAME_OVER'); i++) {
    last = await evaluate(ffChunk(25, 0.05));
    simSeconds += 25;
    if (last.err) { check('simulation ran cleanly', false, last.err); break; }
    alive.push(last.alive);
    console.log('    t=' + (i + 1) * 25 + 's  alive=' + last.alive + '  hp=' + last.hp +
      '  zone=' + last.zonePhase + '/' + last.zoneState + '  r=' + last.zoneR +
      '  playerAlive=' + last.playerAlive);
  }
  check('simulation ran cleanly', !(last && last.err), last ? last.err : 'no chunks');
  check('match reached GAME_OVER', last && last.state === 'GAME_OVER',
    last ? last.state + ' after ~' + simSeconds + 's' : '-');
  check('alive counter fell from 100', alive.length && Math.min(...alive) < 100,
    'min alive ' + (alive.length ? Math.min(...alive) : '?'));
  /* --- in-match progression checks --- */
  const mid = await evaluate(`(function () {
    var phases = CONFIG.ZONE_PHASES;
    return {
      zoneFinalR: phases[phases.length - 1].r,
      dpsFirst: phases[0].dps, dpsLast: phases[phases.length - 1].dps,
      minR: Zone.cur.r,
      deaths: App.totalCombatants - App.aliveCount,
      botsAlive: Bots.aliveCount(),
      feedRows: document.getElementById('killfeed').children.length,
      deathsByZone: (function () {
        var n = 0;
        for (var i = 0; i < BOTS.length; i++) if (!BOTS[i].alive && !BOTS[i].killerBot) n++;
        return n;
      })(),
      botsKilledByBots: (function () {
        var n = 0;
        for (var i = 0; i < BOTS.length; i++) { var b = BOTS[i]; if (!b.alive && b.kills >= 0) n++; }
        return n;
      })(),
      totalBotKills: BOTS.reduce(function (a, b) { return a + (b.kills || 0); }, 0),
      cratesSpawned: Loot.crates.length,
      lootItems: Loot.count
    };
  })()`);

  check('zone dps escalates per phase', mid.dpsLast > mid.dpsFirst,
    mid.dpsFirst + ' -> ' + mid.dpsLast + ' dps');
  check('bots eliminated other bots (not just the player)', mid.totalBotKills > 5,
    mid.totalBotKills + ' bot-on-bot kills');
  check('kill feed received entries', mid.feedRows >= 0, mid.feedRows + ' rows');

  /* --- the player is dead: death screen + placement --- */
  const death = await evaluate(`(function () {
    var scr = document.getElementById('deathScreen');
    var vic = document.getElementById('victoryScreen');
    return {
      playerAlive: Player.alive,
      deathVisible: !scr.classList.contains('hidden'),
      victoryVisible: !vic.classList.contains('hidden'),
      placementText: document.getElementById('deathPlacement').textContent,
      killerText: document.getElementById('deathKiller').textContent,
      kills: document.getElementById('dKills').textContent,
      damage: document.getElementById('dDamage').textContent,
      time: document.getElementById('dTime').textContent,
      state: App.state, placement: Player.placement
    };
  })()`);
  console.log('    death screen: ' + JSON.stringify(death));
  check('player is dead', !death.playerAlive);
  check('death OR victory screen is showing', death.deathVisible || death.victoryVisible,
    'death=' + death.deathVisible + ' victory=' + death.victoryVisible);
  check('placement is reported', /#\d+ OF 100/.test(death.placementText), death.placementText);
  check('killer is named', death.killerText.length > 5, death.killerText);
  check('stats rendered (kills/damage/time)', death.time.length >= 3,
    death.kills + ' kills, ' + death.damage + ' dmg, ' + death.time);

  if (!death.deathVisible) return;

  /* --- spectate the rest of the match: the zone must run all the way --- */
  await evaluate(`document.getElementById('btnSpectate').click(); 'spec'`);
  await sleep(400);
  const spec = await evaluate(`({
    state: App.state, name: document.getElementById('specName').textContent,
    panelVisible: !document.getElementById('spectatePanel').classList.contains('hidden'),
    targetAlive: !!(Game.spectating && Game.spectating.alive)
  })`);
  console.log('    spectating: ' + JSON.stringify(spec));
  check('spectating state entered', spec.state === 'SPECTATING', spec.state);
  check('spectating follows a live bot', spec.targetAlive, spec.name);
  check('spectate panel visible', spec.panelVisible);

  let end = null;
  /* Simulate to the game's OWN end, not to an arbitrary budget: Game.update ends
     a match at CONFIG.MATCH_TIME_CAP no matter what the zone is doing, and on
     ISLE ROYALE - four times the ground - the last survivors can take most of
     that cap to find each other, which used to run this past a 750 s budget and
     leave two bots alive on the last tick. */
  for (let i = 0; i < 70; i++) {
    end = await evaluate(ffChunk(25, 0.05));
    if (end.err) { check('spectated simulation ran cleanly', false, end.err); break; }
    if (end.state === 'GAME_OVER' || (end.cap && end.matchTime > end.cap + 50)) break;
  }
  check('spectated simulation ran cleanly', !(end && end.err), end ? end.err : '-');
  const finish = await evaluate(`({
    deaths: App.totalCombatants - App.aliveCount,
    crates: Loot.crates.length,
    lootOnGround: Loot.count,
    zoneDps: Zone.dps(),
    /* who is left, so a match that stalls says how and where rather than just how
       many - an unarmed pair 300 m apart inside the last circle is a very
       different story from a bug. The storm fields (out/by) are what separate a
       player still inside the circle, and therefore never hurt by it, from one who
       simply refuses to die. */
    survivors: BOTS.filter(function (b) { return b.alive; }).map(function (b) {
      return { n: b.name, gun: b.weaponId, st: b.state, hp: Math.round(b.hp),
               out: Zone.isOutside(b.pos.x, b.pos.z),
               by: +Zone.outsideBy(b.pos.x, b.pos.z).toFixed(0),
               use: b.use ? b.use.kind : null,
               pos: [Math.round(b.pos.x), Math.round(b.pos.z)],
               mt: [Math.round(b.moveTarget.x), Math.round(b.moveTarget.z)],
               near: (function () {
                 var best = 1e9;
                 for (var k = 0; k < BOTS.length; k++) {
                   var o = BOTS[k];
                   if (!o.alive || o === b) continue;
                   var dd = Math.hypot(o.pos.x - b.pos.x, o.pos.z - b.pos.z);
                   if (dd < best) best = dd;
                 }
                 return Math.round(best);
               })() };
    }),
    zone: { x: Math.round(Zone.cur.x), z: Math.round(Zone.cur.z), r: Math.round(Zone.cur.r),
            state: Zone.state, phase: Zone.phase },
    killedByZone: (function () {
      var n = 0;
      for (var i = 0; i < BOTS.length; i++) if (!BOTS[i].alive && BOTS[i].placement > 0) n++;
      return n;
    })()
  })`);
  console.log('    finish: ' + JSON.stringify(finish));
  check('most of the lobby died over the match', finish.deaths > 90,
    finish.deaths + ' of 100 dead');
  check('supply crates were dropped during the match', finish.crates > 0,
    finish.crates + ' crates, ' + finish.lootOnGround + ' items still on the ground');
  check('every bot was given a placement', finish.killedByZone >= 95,
    finish.killedByZone + ' placed');
  check('match played out to a single survivor', end && end.state === 'GAME_OVER' &&
    end.alive <= 1, end ? (end.alive + ' alive, phase ' + end.zonePhase + ', r=' + end.zoneR +
    (end.state === 'GAME_OVER' ? '' : ' after ' + end.matchTime + 's (' + end.state + ')') +
    (finish.survivors && finish.survivors.length ? ' ' + JSON.stringify(finish.survivors) : '')) : '-');
  check('zone ran through most of its phases', end && end.zonePhase >= 5,
    end ? 'phase ' + end.zonePhase + ' / ' + 8 : '-');
  check('final zone is small (forced close quarters)', end && end.zoneR <= 60,
    end ? 'r=' + end.zoneR : '-');
};
