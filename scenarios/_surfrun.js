// Surf City match probe: forces the rotation onto SURF CITY, drops in, then
// fast-forwards a real match on the new terrain (the game's own Game.update is
// stepped with a fixed timestep) and reports how the bots did. Catches terrain
// changes that strand the island's navigation, spawns or loot.
//
//   node cdp-test.js _surfrun
function ffChunk(seconds, dt) {
  return `(function () {
    var steps = Math.round(${seconds} / ${dt});
    var i = 0, err = null;
    for (; i < steps; i++) {
      if (App.state === 'GAME_OVER') break;
      try { Game.update(${dt}); } catch (e) {
        err = (e && e.message) + ' || ' + String(e && e.stack || '').split('\\n')[1];
        break;
      }
    }
    var moving = 0, botsInWater = 0, bots = 0;
    for (var b = 0; b < BOTS.length; b++) {
      var bot = BOTS[b];
      if (!bot.alive) continue;
      bots++;
      if (bot.vel && Math.hypot(bot.vel.x || 0, bot.vel.z || 0) > 1.5) moving++;
      if (World.heightAt(bot.pos.x, bot.pos.z) < -1.5) botsInWater++;
    }
    return {
      steps: i, err: err, state: App.state, alive: App.aliveCount,
      playerAlive: Player.alive, hp: Math.round(Player.hp),
      zonePhase: Zone.phase, zoneR: +Zone.cur.r.toFixed(1),
      matchTime: +App.matchTime.toFixed(1), map: World.mapId,
      moving: moving, liveBots: bots, botsInWater: botsInWater,
      playerH: Math.round(World.heightAt(Player.pos.x, Player.pos.z) * 10) / 10
    };
  })()`;
}

module.exports = async function surfrun(ctx) {
  const { evaluate, check, sleep } = ctx;

  /* force the match onto the Surf City slot whatever the wall clock says */
  const start = await evaluate(`(function () {
    var keep = MapRotation.current;
    MapRotation.current = function () { return MAP_DEFS[1]; };
    try { App.startMatch(); } finally { MapRotation.current = keep; }
    return { state: App.state, alive: App.aliveCount, map: World.mapId,
             towns: World.towns.length, roads: World.roads.length };
  })()`);
  check('a match can start on Surf City', start.map === 'surf' && start.state === 'BUS',
    JSON.stringify(start));

  let last = null;
  for (let i = 0; i < 6 && (!last || last.state !== 'GAME_OVER'); i++) {
    last = await evaluate(ffChunk(30, 0.05));
    if (last.err) { check('surf simulation ran cleanly', false, last.err); break; }
    console.log('    t=' + (i + 1) * 30 + 's  alive=' + last.alive + '  bots moving=' +
      last.moving + '/' + last.liveBots + '  in water=' + last.botsInWater +
      '  player y=' + last.playerH);
  }
  check('surf simulation ran cleanly', !(last && last.err), last ? last.err : 'no chunks');
  check('the map is still Surf City', last && last.map === 'surf', last && last.map);
  check('bots are alive and moving on the new terrain',
    last && last.liveBots > 0 && last.moving > 0,
    last ? last.moving + '/' + last.liveBots + ' bots moving' : '-');
  check('almost no bot drowns', last && last.botsInWater <= Math.max(1, last.liveBots * 0.1),
    last ? last.botsInWater + '/' + last.liveBots + ' in water' : '-');
  check('the alive counter falls (combat happens)', last && last.alive < 100,
    last ? 'alive ' + last.alive : '-');
  check('the player stays on dry land', last && last.playerH > 0,
    last ? 'player ground ' + last.playerH : '-');
  await sleep(200);
  await evaluate(`App.quitToMenu(); true;`);
};
