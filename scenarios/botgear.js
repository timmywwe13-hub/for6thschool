// Bot gear scenario: nobody is handed a weapon at spawn - bots have to find
// guns by looting, and once armed they can actually shoot each other.
module.exports = async function botgear(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1000);

  /* Keep the human alive for this scenario: we are measuring how bots gear up
     over a whole match, and an idle player dying at 16 s would end it. */
  await evaluate(`(function () {
    if (!window.__origHitDamage) {
      window.__origHitDamage = Hit.damage.bind(Hit);
      Hit.damage = function (e, amount, opts) {
        if (e === Player) return 0;
        return window.__origHitDamage(e, amount, opts);
      };
    }
    return 'ok';
  })()`);

  const atSpawn = await evaluate(`(function () {
    var armed = 0, withMag = 0, withWeapons = 0, withItems = 0;
    var sample = null;
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (b.weaponId) armed++;
      if (b.mag > 0) withMag++;
      if (b.weapons && b.weapons.length) withWeapons++;
      if (b.inv.medkit || b.inv.bandage || b.inv.shield || b.inv.nade) withItems++;
      if (!sample) sample = { name: b.name, weapon: b.weaponId, mag: b.mag, kits: b.weapons.length };
    }
    return { bots: BOTS.length, armed: armed, withMag: withMag, withWeapons: withWeapons,
             withItems: withItems, sample: sample,
             playerWeapons: Player.weapons.filter(function (x) { return !!x; }).length,
             playerKits: Player.inv.medkit + Player.inv.bandage + Player.inv.shield };
  })()`);
  console.log('  at spawn: ' + JSON.stringify(atSpawn));
  check('bots land with no weapon in hand', atSpawn.armed === 0, atSpawn.armed + ' armed');
  check('bots land with empty magazines', atSpawn.withMag === 0 && atSpawn.withWeapons === 0,
    atSpawn.withMag + ' mags / ' + atSpawn.withWeapons + ' kits');
  check('bots land with no free consumables either', atSpawn.withItems === 0,
    atSpawn.withItems + ' carrying items');
  check('the player also starts empty handed',
    atSpawn.playerWeapons === 0 && atSpawn.playerKits === 0, JSON.stringify(atSpawn));

  /* let them land and hunt for gear. The match opens on the battle bus, so the
     first thing this does is jump - otherwise the 26 s ride eats the window. */
  const sim = (seconds, dt) => `(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < Math.round(${seconds} / ${dt}); i++) {
      if (App.state === 'GAME_OVER') break;
      Game.update(${dt});
    }
    var armed = 0, alive = 0, mags = 0, tiers = [0, 0, 0, 0, 0];
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (!b.alive) continue;
      alive++;
      if (b.weaponId) { armed++; mags += b.mag; tiers[CONFIG.WEAPONS[b.weaponId].tier]++; }
    }
    return { state: App.state, alive: alive, armed: armed,
             fraction: alive ? +(armed / alive).toFixed(2) : 0,
             mags: mags, tiers: tiers, t: +App.matchTime.toFixed(0) };
  })()`;

  const early = await evaluate(sim(30, 0.05));
  console.log('  after 30s: ' + JSON.stringify(early));
  check('some bots have found guns within 30 s', early.armed > 5,
    early.armed + '/' + early.alive + ' armed');
  check('the ones that armed themselves have loaded magazines', early.mags > 0,
    early.mags + ' rounds spread around');

  /* Guns only come out of chests now, so the lobby arms itself over the first
     minute or two of ground time instead of instantly - measured across seeds,
     roughly a third of the survivors carry a weapon at 30 s and half of them by
     90 s, with the curve still climbing after that. The bar is set to that
     design, not to the old floor-loot figure (see scenarios/_lootflow.js for the
     full curve, which asserts the trend rather than a number). */
  const mid = await evaluate(sim(60, 0.05));
  console.log('  after 90s: ' + JSON.stringify(mid));
  check('half the surviving bots armed themselves by looting', mid.fraction > 0.45,
    Math.round(mid.fraction * 100) + '% armed (' + mid.armed + '/' + mid.alive + ')');
  check('guns of many rarities are in bot hands',
    mid.tiers.filter(t => t > 0).length >= 3, 'tiers ' + mid.tiers.join('/'));

  const combat = await evaluate(`({
    botKills: BOTS.reduce(function (a, b) { return a + (b.kills || 0); }, 0),
    dead: App.totalCombatants - App.aliveCount,
    unarmedDead: BOTS.filter(function (b) { return !b.alive; }).length,
    botsWithGunMesh: (function () {
      var m = new THREE.Matrix4(), n = 0;
      for (var i = 0; i < BOTS.length; i++) {
        var b = BOTS[i];
        if (b.alive && b.weaponId) { n++; }
      }
      void m;
      return n;
    })()
  })`);
  console.log('  combat: ' + JSON.stringify(combat));
  check('armed bots actually fight each other', combat.botKills > 3,
    combat.botKills + ' bot-on-bot kills');
  check('the lobby is being whittled down', combat.dead > 3, combat.dead + ' eliminated');

  /* a bot with a gun must show it: the instanced gun matrix is not zeroed.
     The bot view only syncs bots within 420 m of the player (see Bots' view pass
     in index.html), and a bot further out keeps zeroed matrices - so pick the
     nearest armed bot in view rather than the first one in the array, which on
     ISLE ROYALE is usually on the far side of the island. */
  const gunMesh = await evaluate(`(function () {
    var armed = null, armedD = 1e9, unarmed = null, unarmedD = 1e9;
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (!b.alive) continue;
      var d = Math.hypot(b.pos.x - Player.pos.x, b.pos.z - Player.pos.z);
      if (d > 420) continue;                    // out of the view pass
      if (b.weaponId) { if (d < armedD) { armedD = d; armed = b; } }
      else if (d < unarmedD) { unarmedD = d; unarmed = b; }
    }
    if (!armed) return { err: 'no armed bot inside the 420 m view of the player' };
    var m = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    BotView.gun.getMatrixAt(armed.index, m);
    m.decompose(v, q, s);
    var armedScale = +s.length().toFixed(2);
    var unarmedScale = -1;
    if (unarmed) {
      BotView.gun.getMatrixAt(unarmed.index, m);
      m.decompose(v, q, s);
      unarmedScale = +s.length().toFixed(2);
    }
    return { armedName: armed.name, armedWeapon: armed.weaponId, armedScale: armedScale,
             unarmedScale: unarmedScale };
  })()`);
  console.log('  gun mesh: ' + JSON.stringify(gunMesh));
  check('an armed bot renders a gun model', gunMesh.armedScale > 0.5, 'scale ' + gunMesh.armedScale);
  if (gunMesh.unarmedScale >= 0) {
    check('an unarmed bot renders no gun', gunMesh.unarmedScale < 0.01,
      'scale ' + gunMesh.unarmedScale);
  }
};
