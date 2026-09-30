// Focused probe: where does the bot loot flow stall now that guns only come out
// of chests? Reports, after a fixed amount of ground time, how many chests were
// opened, how many bots are armed, what the unarmed ones are doing and how far
// they are from the nearest unopened chest - so a shortfall can be blamed on the
// supply, the routing or the pickup step instead of guessed at.
module.exports = async function lootflow(ctx) {
  const { evaluate, check } = ctx;

  await evaluate(`App.startMatch(); 1`);

  const run = (seconds) => `(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    /* Cumulative arming: a bot seen holding a gun at any sampled frame of ANY
       window counts once, for the rest of the match. The instantaneous fraction
       below is diluted by the armed bots dying in the fights they start, so its
       trend says more about who is winning than about whether the lobby is arming
       itself out of the chests. */
    if (!window.__everArmed) window.__everArmed = {};
    var ever = window.__everArmed;
    for (var i = 0; i < Math.round(${seconds} / 0.05); i++) {
      if (App.state === 'GAME_OVER') break;
      /* this probe is about the lobby arming itself, not about surviving: keep
         the player topped up so the match cannot end mid-measurement */
      Player.hp = CONFIG.MAX_HP;
      Player.shield = CONFIG.MAX_SHIELD;
      Game.update(0.05);
      if (i % 5 === 0) {
        for (var s = 0; s < BOTS.length; s++) if (BOTS[s].weaponId) ever[BOTS[s].index] = 1;
      }
    }
    var armed = 0, alive = 0, unarmed = [], states = {};
    var far = 0, near = 0, sumDist = 0, noChest = 0, high = 0;
    for (var b = 0; b < BOTS.length; b++) {
      var bot = BOTS[b];
      if (!bot.alive) continue;
      alive++;
      states[bot.state] = (states[bot.state] || 0) + 1;
      if (bot.weaponId) { armed++; continue; }
      /* an unarmed survivor: how far is the nearest chest it has not opened? */
      var ch = Loot.nearestChest(bot.pos.x, bot.pos.z, bot.pos.y, 5000);
      if (!ch) {
        /* The chest query ignores anything more than 2.6 m off the bot's own
           level, exactly like the player's pickup reach through a floor. A bot on
           a roof, on the dam or in a glider is therefore a known straggler - only
           count bots standing on real ground, where a chest at their feet WOULD
           have been found. */
        if (Math.abs(bot.pos.y - World.heightAt(bot.pos.x, bot.pos.z)) < 2.5) noChest++;
        else high++;
        continue;
      }
      var d = Math.hypot(ch.x - bot.pos.x, ch.z - bot.pos.z);
      sumDist += d;
      if (d < 30) near++; else far++;
      if (unarmed.length < 4) {
        var gw = Loot.nearestWeapon(bot.pos.x, bot.pos.z, bot.pos.y, 5000);
        var gw240 = Loot.nearestWeapon(bot.pos.x, bot.pos.z, bot.pos.y, 240);
        unarmed.push({ state: bot.state, d: Math.round(d),
          dm: Math.round(Math.hypot(bot.moveTarget.x - bot.pos.x, bot.moveTarget.z - bot.pos.z)),
          gun: gw ? Math.round(Math.hypot(gw.x - bot.pos.x, gw.z - bot.pos.z)) : -1,
          gunY: gw ? +(gw.y - bot.pos.y).toFixed(2) : 0,
          gun240: !!gw240,
          pursuing: bot.pursuing, lost: bot.lost ? Object.keys(bot.lost).length : 0,
          stuck: +bot.stuckT.toFixed(1), lootT: +bot.lootFindT.toFixed(1) });
      }
    }
    /* how much loot is lying around, and how much of it is a gun? */
    var gunsOnFloor = 0;
    for (var k = 0; k < 200; k++) {
      var w = Loot.nearestWeapon(k * 5 - 500, 0, 10, 1e9);
      if (w) gunsOnFloor++;
    }
    return { t: Math.round(App.matchTime), state: App.state, alive: alive, armed: armed,
             fraction: alive ? +(armed / alive).toFixed(2) : 0,
             everArmed: Object.keys(ever).length,
             chests: Loot.chestCount(), opened: Loot.chestsOpened(),
             groundItems: Loot.count, unarmedStates: states,
             unarmedNear: near, unarmedFar: far, unarmedNoChest: noChest, unarmedHigh: high,
             avgDist: (near + far) ? Math.round(sumDist / (near + far)) : -1,
             sample: unarmed };
  })()`;

  const t30 = await evaluate(run(30));
  console.log('  +30s  ' + JSON.stringify(t30));
  const t60 = await evaluate(run(30));
  console.log('  +60s  ' + JSON.stringify(t60));
  const t120 = await evaluate(run(60));
  console.log('  +120s ' + JSON.stringify(t120));
  check('chests keep being opened all match',
    t120.opened > t60.opened && t60.opened > t30.opened,
    t30.opened + ' -> ' + t60.opened + ' -> ' + t120.opened + ' of ' + t120.chests);
  /* This is a trend probe, not a bar: the exact arming curve depends on the seed
     and on the bus line, and what has to hold is that the lobby keeps arming
     itself out of the chests and is never handed a gun any other way. Counted
     cumulatively, so armed bots dying in a fight cannot make the curve dip. */
  check('the lobby arms itself as the match goes on',
    t120.everArmed > t60.everArmed && t60.everArmed > t30.everArmed,
    t30.everArmed + ' -> ' + t60.everArmed + ' -> ' + t120.everArmed +
    ' different bots armed as the match went on (' + t30.armed + ' -> ' + t60.armed + ' -> ' +
    t120.armed + ' holding one, ' + Math.round(t30.fraction * 100) + '% -> ' +
    Math.round(t60.fraction * 100) + '% -> ' + Math.round(t120.fraction * 100) +
    '% of the survivors)');
  /* a couple of stragglers are expected - a bot swimming far out at sea, or one
     on a roof, is nowhere near a chest in the height sense - but nobody should
     be left with the whole island exhausted while standing on bare ground */
  check('unarmed bots are never left with no chest at all',
    t120.unarmedNoChest <= 2,
    t120.unarmedNoChest + ' stranded on the ground' +
    (t120.unarmedHigh ? ', ' + t120.unarmedHigh + ' more up on a roof or in the air' : ''));
  return { t30, t60, t120 };
};
