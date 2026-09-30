// Boot scenario: page loads from file://, WebGL starts, every module exists,
// a match can be generated and the drop phase begins.
module.exports = async function boot(ctx) {
  const { evaluate, check, sleep } = ctx;

  const env = await evaluate(`(function () {
    var names = ['CONFIG','RNG','SFX','World','Loot','Bots','BOTS','Zone','Player','Game','UI','Hit',
                 'Input','FX','PlayerView','Maps','Projectiles','BotView','App','SETTINGS'];
    var missing = [], present = [];
    for (var i = 0; i < names.length; i++) {
      try { if (typeof eval(names[i]) === 'undefined') missing.push(names[i]); else present.push(names[i]); }
      catch (e) { missing.push(names[i] + '(ref)'); }
    }
    var bootLoading = document.getElementById('bootLoading');
    var bootError = document.getElementById('bootError');
    return {
      three: typeof window.THREE !== 'undefined' ? window.THREE.REVISION : null,
      missing: missing,
      present: present.length,
      bootLoadingHidden: !!bootLoading && bootLoading.classList.contains('hidden'),
      bootErrorVisible: !!bootError && !bootError.classList.contains('hidden'),
      bootErrorText: bootError ? document.getElementById('bootErrorText').textContent : '',
      state: (typeof App !== 'undefined') ? App.state : 'no-App',
      sceneChildren: (typeof App !== 'undefined' && App.scene) ? App.scene.children.length : -1,
      rendererOk: (typeof App !== 'undefined') && !!App.renderer,
      botNames: (typeof BOT_NAMES !== 'undefined') ? BOT_NAMES.length : -1,
      weapons: (typeof CONFIG !== 'undefined') ? Object.keys(CONFIG.WEAPONS).length : -1,
      phases: (typeof CONFIG !== 'undefined') ? CONFIG.ZONE_PHASES.length : -1,
      botCount: (typeof CONFIG !== 'undefined') ? CONFIG.BOT_COUNT : -1,
      canvasW: document.getElementById('gameCanvas') ? document.getElementById('gameCanvas').width : -1,
      rngNotReady: (typeof BOT_NAMES !== 'undefined') && BOT_NAMES.length < 100
    };
  })()`);

  check('three.js loaded from CDN', env.three === '160', 'REVISION=' + env.three);
  check('no module failed to declare', env.missing.length === 0, env.missing.join(','));
  check('boot loading overlay hidden', env.bootLoadingHidden);
  check('no WebGL error screen', !env.bootErrorVisible, env.bootErrorText);
  check('WebGL renderer created', env.rendererOk);
  check('state is MENU', env.state === 'MENU', env.state);
  check('canvas has a backing size', env.canvasW > 100, env.canvasW + 'px');
  check('100+ bot names exist', env.botNames >= 100, env.botNames + ' names');
  check('6+ weapons defined', env.weapons >= 6, env.weapons + ' weapons');
  check('6+ zone phases defined', env.phases >= 6, env.phases + ' phases');
  check('bot count >= 40', env.botCount >= 40, env.botCount);

  // ---- start a match by clicking the real menu button ----
  const startVisible = await evaluate(
    `(function () {
       var b = document.getElementById('btnPlay');
       if (!b) return 'no button';
       if (b.offsetParent === null) return 'hidden';
       return 'ok';
     })()`);
  check('start button visible on title screen', startVisible === 'ok', startVisible);

  await evaluate(`document.getElementById('btnPlay').click(); 'clicked'`);
  await sleep(2500);

  /* the match opens on the battle bus, so the first thing to check is the ride
     and then the jump into the skydive */
  const ride = await evaluate(`(function () {
    return { state: App.state, riding: Bus.riding, active: Bus.active,
             y: +Bus.pos.y.toFixed(1), altitude: CONFIG.BUS_ALTITUDE,
             riders: Bus.riders(),
             panel: !document.getElementById('busPanel').classList.contains('hidden'),
             botsAboard: Bots.busRiderCount() };
  })()`);
  check('match opens on the battle bus', ride.state === 'BUS' && ride.active, ride.state);
  check('the bus flies at cruise altitude', Math.abs(ride.y - ride.altitude) < 1, ride.y);
  check('everybody is aboard', ride.riders === 100 && ride.botsAboard === 99,
    ride.riders + ' riders, ' + ride.botsAboard + ' bots');
  check('the bus panel is on screen', ride.panel);

  await evaluate(`Bus.jump(); 'jumped'`);
  await sleep(400);

  const match = await evaluate(`(function () {
    return {
      state: App.state,
      total: App.totalCombatants,
      alive: App.aliveCount,
      bots: BOTS.length,
      botsAlive: Bots.aliveCount(),
      playerAlive: Player.alive,
      airborne: Player.airborne,
      playerY: +Player.pos.y.toFixed(1),
      glider: Player.gliderOpen,
      lootApi: Object.keys(Loot).join(','),
      crateCount: Loot.crates.length,
      chests: Loot.chestCount(),
      lootItems: Loot.count,
      colliders: World.colliders.length,
      worldColliders: World.colliders.length,
      towns: World.towns.length,
      landmarks: World.landmarks.length,
      trees: World.treeSpots.length,
      hudVisible: !document.getElementById('hud').classList.contains('hidden'),
      zoneR: +Zone.cur.r.toFixed(1),
      /* the opening circle scales with the map (Zone.reset uses zoneScale()), so
         compare against the scale the game itself is using: the classic island
         opens at 470 and ISLE ROYALE - in rotation for half of every hour - at
         940, and a hard-coded 470 fails for exactly that reason */
      zoneStart: +(CONFIG.ZONE_START_R * zoneScale()).toFixed(1),
      mapId: World.mapId,
      zPhase: Zone.phase,
      sceneChildren: App.scene.children.length,
      drawCalls: App.renderer.info.render.calls,
      triangles: App.renderer.info.render.triangles,
      botMeshes: (typeof BotView !== 'undefined') ? BotView.count : -1
    };
  })()`);

  check('the jump starts the skydive', match.state === 'DROP' && match.airborne, match.state);
  check('100 combatants', match.total === 100, match.total);
  check('bots spawned', match.bots >= 40, match.bots + ' bots, ' + match.botsAlive + ' alive');
  check('player is alive and high up', match.playerAlive && match.playerY > 100,
    'y=' + match.playerY);
  check('HUD shown', match.hudVisible);
  check('loot spawned', match.lootItems > 100, match.lootItems + ' ground items');
  check('chests hidden around the island', match.chests >= 100, match.chests + ' chests');
  check('world has colliders', match.worldColliders > 500, match.worldColliders + ' colliders');
  check('3+ named towns', match.towns >= 3, match.towns);
  check('4+ landmarks', match.landmarks >= 4, match.landmarks);
  check('150+ trees', match.trees >= 150, match.trees);
  check('zone initialised to the current map\'s opening circle',
    match.zoneR === match.zoneStart && match.zoneR > 0,
    match.mapId + ': ' + match.zoneR + ' (zoneScale() wants ' + match.zoneStart + ')');
  check('renderer is drawing', match.drawCalls > 0, match.drawCalls + ' calls / ' + match.triangles + ' tris');

  console.log('\n  match snapshot: ' + JSON.stringify(match));
};
