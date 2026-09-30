// Victory scenario: the player is the last one standing -> VICTORY ROYALE
// screen with stats, then the restart path from that screen.
module.exports = async function victory(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1200);

  /* Keep the human alive for the duration of this scenario: we are testing the
     win screen and the restart path, not whether a bot happens to shoot an idle
     player during warm-up. */
  await evaluate(`(function () {
    window.__godMode = true;
    var orig = Hit.damage.bind(Hit);
    window.__origHitDamage = orig;
    Hit.damage = function (e, amount, opts) {
      if (window.__godMode && e === Player) return 0;
      return orig(e, amount, opts);
    };
    return 'ok';
  })()`);

  /* let the drop finish and a few fights start so the stats are non-trivial */
  const warm = await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < 1200; i++) { if (App.state === 'GAME_OVER') break; Game.update(0.05); }
    return { state: App.state, alive: App.aliveCount, loot: Loot.count };
  })()`);
  check('warm-up ran and the player is live', warm.state === 'PLAYING' && warm.alive > 0,
    JSON.stringify(warm));
  const lootBefore = warm.loot;

  /* the player takes the last kill: every remaining bot dies to a "player" shot */
  const wiped = await evaluate(`(function () {
    var killed = 0;
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (!b.alive) continue;
      Hit.damage(b, 9999, { attacker: Player, weapon: 'Assault Rifle', head: false });
      killed++;
    }
    return { killed: killed, state: App.state, alive: App.aliveCount, placement: Player.placement,
             kills: Player.kills, loot: Loot.count };
  })()`);
  console.log('    wiped ' + wiped.killed + ' bots -> ' + JSON.stringify(wiped));
  check('all remaining bots died', wiped.killed > 40, wiped.killed + ' bots killed');
  check('player placement is #1', wiped.placement === 1, wiped.placement);
  check('winner count is 1', wiped.alive === 1, wiped.alive);
  check('kills were credited to the player exactly once each', wiped.kills === wiped.killed,
    wiped.kills + ' kills for ' + wiped.killed + ' wiped bots');
  check('victim gear dropped as loot', wiped.loot > lootBefore, lootBefore + ' -> ' + wiped.loot);

  const vic = await evaluate(`(function () {
    var s = document.getElementById('victoryScreen');
    return {
      visible: !s.classList.contains('hidden'),
      state: App.state, win: App.win,
      sub: document.getElementById('victorySub').textContent,
      kills: document.getElementById('vKills').textContent,
      damage: document.getElementById('vDamage').textContent,
      time: document.getElementById('vTime').textContent,
      accuracy: document.getElementById('vAccuracy').textContent,
      hudHidden: document.getElementById('hud').classList.contains('hidden'),
      feedRows: document.getElementById('killfeed').children.length,
      deathHidden: document.getElementById('deathScreen').classList.contains('hidden')
    };
  })()`);
  console.log('    victory screen: ' + JSON.stringify(vic));
  check('VICTORY screen is showing', vic.visible && vic.state === 'GAME_OVER' && vic.win === true,
    vic.state);
  check('victory subtitle says #1', /#1 OF 100/.test(vic.sub), vic.sub);
  check('victory kill total matches the wipe', vic.kills === String(wiped.kills) || vic.kills === String(wiped.killed),
    vic.kills + ' shown / ' + wiped.killed + ' wiped');
  check('victory damage total is numeric', /^\d+$/.test(vic.damage), vic.damage);
  check('victory time survived is clocked', /^\d+:\d\d$/.test(vic.time), vic.time);
  check('accuracy is a percentage', /%$/.test(vic.accuracy), vic.accuracy);
  check('death screen stayed hidden', vic.deathHidden);
  check('kill feed was populated by the wipe', vic.feedRows > 0, vic.feedRows + ' rows');

  /* ---- restart straight from the victory screen ---- */
  await evaluate(`document.getElementById('btnPlayAgain2').click(); 'again'`);
  await sleep(1500);
  const again = await evaluate(`({
    state: App.state, alive: App.aliveCount, bots: BOTS.length, botsAlive: Bots.aliveCount(),
    kills: Player.kills, dmg: Player.damageDealt, hp: Player.hp, shield: Player.shield,
    placement: Player.placement, win: App.win, phase: Zone.phase, zoneR: Zone.cur.r,
    /* the opening circle scales with the map: zoneScale() is what Zone.reset uses */
    zoneStart: CONFIG.ZONE_START_R * zoneScale(),
    loot: Loot.count, victoryHidden: document.getElementById('victoryScreen').classList.contains('hidden'),
    feed: document.getElementById('killfeed').children.length, airborne: Player.airborne,
    bus: Bus.riding
  })`);
  console.log('    restarted match: ' + JSON.stringify(again));
  check('second match started on the bus', again.state === 'BUS', again.state);
  check('100 combatants again', again.alive === 100 && again.bots === 99,
    again.alive + ' alive / ' + again.bots + ' bots');
  check('player stats reset', again.kills === 0 && again.dmg === 0 && again.hp === 100 &&
    again.placement === 0 && again.win === false, JSON.stringify(again));
  check('zone reset to phase 0', again.phase === 0 && again.zoneR === again.zoneStart,
    again.phase + '/' + again.zoneR + ' (zoneScale() wants ' + again.zoneStart + ')');
  check('loot repopulated', again.loot > 100, again.loot + ' items');
  check('victory screen hidden', again.victoryHidden);
  check('kill feed cleared', again.feed === 0, again.feed + ' rows');
  check('player is riding the bus again', again.bus === true);

  /* the second match must be playable, not a frozen corpse of the first. Bots
     spawn unarmed now, so nobody dies in the first half minute - run far enough
     that they have had time to loot, and prove the AI is alive both ways. */
  const played = await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < 1800; i++) { if (App.state === 'GAME_OVER') break; Game.update(0.05); }
    var armed = 0, states = { loot: 0, engage: 0, rotate: 0 };
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (!b.alive) continue;
      if (b.weaponId) armed++;
      if (states[b.state] !== undefined) states[b.state]++;
    }
    return { state: App.state, alive: App.aliveCount, playerAlive: Player.alive,
             playerY: +Player.pos.y.toFixed(1), botsAlive: Bots.aliveCount(),
             armed: armed, states: states, loot: Loot.count };
  })()`);
  console.log('    second match after 90s: ' + JSON.stringify(played));
  check('second match is live and progressing', played.state === 'PLAYING' && played.playerAlive,
    JSON.stringify(played));
  check('bots loot weapons again in match 2', played.armed > 0,
    played.armed + ' bots armed');
  check('bots are still dying in match 2 once armed', played.botsAlive < 99,
    played.alive + ' alive, ' + played.botsAlive + ' bots, ' + played.armed + ' armed');
};
