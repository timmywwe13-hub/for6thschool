// Focused probe: what exactly does Hit.damage do to a bot?
module.exports = async function hitprobe(ctx) {
  const { evaluate, check, sleep } = ctx;
  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1000);
  await evaluate(`(function () {
    for (var i = 0; i < 40; i++) { if (App.state === 'GAME_OVER') break; Game.update(0.05); }
    return 'warm';
  })()`);

  const one = await evaluate(`(function () {
    var b = null;
    for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) { b = BOTS[i]; break; }
    if (!b) return { err: 'no live bot' };
    var killsBefore = Player.kills;
    var before = { alive: b.alive, hp: b.hp, shield: b.shield, helm: b.helmetTier, vest: b.vestTier, name: b.name };
    var ret = Hit.damage(b, 9999, { attacker: Player, weapon: 'Test' });
    return { before: before, ret: ret, afterHp: b.hp, afterAlive: b.alive,
             killsBefore: killsBefore, killsAfter: Player.kills,
             botsAlive: Bots.aliveCount(), appAlive: App.aliveCount,
             sameObject: b === BOTS[0] ? 'index0' : 'other' };
  })()`);
  console.log('  single lethal hit: ' + JSON.stringify(one));
  check('lethal hit kills the bot', one.afterAlive === false, JSON.stringify(one.afterHp));
  check('kill credited', one.killsAfter > one.killsBefore, one.killsBefore + ' -> ' + one.killsAfter);

  const all = await evaluate(`(function () {
    var attempted = 0, died = 0, rets = [];
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (!b.alive) continue;
      attempted++;
      var r = Hit.damage(b, 9999, { attacker: Player, weapon: 'Test' });
      if (r === 0) rets.push({ name: b.name, reason: 'returned 0', hp: b.hp, alive: b.alive });
      if (!b.alive) died++;
    }
    var stillAlive = [];
    for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) stillAlive.push(BOTS[i].name);
    return { attempted: attempted, died: died, zeroReturns: rets.slice(0, 6),
             zeroCount: rets.length, stillAlive: stillAlive.slice(0, 8),
             stillAliveCount: stillAlive.length, kills: Player.kills,
             botsAlive: Bots.aliveCount(), state: App.state, placement: Player.placement };
  })()`);
  console.log('  mass wipe: ' + JSON.stringify(all));
  check('every attempted bot died', all.attempted === all.died,
    all.attempted + ' attempted, ' + all.died + ' died');
};
