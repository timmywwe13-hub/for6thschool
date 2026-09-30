// Density probe: how full is each map, per square kilometre?
//
// The world's content counts are supposed to scale with the map (see the note in
// generateProps: "every scattered prop count scales with the world, so a map four
// times the size looks four times as full instead of four times as empty"). A
// count that scales with the linear span while the area scales with its square
// leaves the big island thinner than the small one, and you feel that as an early
// game where nobody finds a gun - which is what scenarios/botgear.js measures from
// the other end (bots armed over time).
//
// So this builds BOTH maps and reports the numbers in the same units, plus the
// mean distance from a random patch of land to the nearest chest, which is the
// quantity a looting bot actually experiences.
//
//   node cdp-test.js _densityprobe
const fs = require('fs');
const path = require('path');

module.exports = async function densityprobe(ctx) {
  const { evaluate, check } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  const measure = mapId => `(function () {
    World.build(QUALITY_PRESETS.high, 20260926, ${JSON.stringify(mapId)});
    /* a match start does this: wipe last match's loot, then lay this world's out */
    Loot.clear();
    Loot.populate();
    Loot.populateChests();
    function inTown(x, z) {
      for (var t = 0; t < World.towns.length; t++) {
        var tw = World.towns[t];
        if (Math.hypot(x - tw.x, z - tw.z) < tw.r) return true;
      }
      return false;
    }
    /* land area: sample the square the map lives in and count the cells that are
       above the waterline. Cell area is (mapSize / N)^2. Town pads are counted
       separately: nine towns 160-260 m across cover most of the big island, so
       "the field" has to exclude them or the two maps are not comparable. */
    var N = 120, size = World.mapSize, step = size / N, land = 0, fieldLand = 0;
    for (var i = 0; i < N; i++) {
      for (var j = 0; j < N; j++) {
        var x = -size / 2 + (i + 0.5) * step, z = -size / 2 + (j + 0.5) * step;
        if (World.heightAt(x, z) <= 1.0) continue;
        land++;
        if (!inTown(x, z)) fieldLand++;
      }
    }
    var km2 = land * step * step / 1e6;
    var fieldKm2 = fieldLand * step * step / 1e6;
    /* random land points, and how far each is from the nearest chest */
    var chests = Loot.chests.filter(function (c) { return c; });
    /* what a match start really left lying on the ground. Loot.count is the
       module's own tally; Loot.each hands the records over so the probe can see
       WHERE the loot ended up - the pools behind it start at 110 slots per shape
       and grow on demand (Loot.growMesh), and a shape that ran out of slots used
       to recycle its furthest instance instead, which quietly teleported loot from
       one end of the island to the other. */
    var live = [];
    Loot.each(function (it) { live.push({ x: it.x, z: it.z }); });
    /* how much of the ground loot sits inside a town pad, and how much of the
       chests stand out in the open - the split that shows a cap quietly stripping
       the loot out of whichever towns the world happened to build first */
    var inTownItems = 0, fieldChests = 0;
    for (var li = 0; li < live.length; li++) if (inTown(live[li].x, live[li].z)) inTownItems++;
    for (var ci = 0; ci < chests.length; ci++) if (!chests[ci].town) fieldChests++;
    function nearest(list, x, z) {
      var b = 1e9;
      for (var n = 0; n < list.length; n++) {
        var d = Math.hypot(list[n].x - x, list[n].z - z);
        if (d < b) b = d;
      }
      return b;
    }
    /* random land points, each measured to the nearest chest; out in the field
       (no town pad) also to the nearest ground item, which is the number a player
       actually feels */
    var dists = [], itemDists = [], rng = 12345;
    function rnd() { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; }
    var tries = 0;
    while (dists.length < 200 && tries++ < 20000) {
      var a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * World.mapRadius * 0.92;
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (World.heightAt(x, z) < 2.5) continue;
      var best = nearest(chests, x, z);
      if (best < 1e8) dists.push(best);
      if (!inTown(x, z)) {
        var bi = nearest(live, x, z);
        if (bi < 1e8) itemDists.push(bi);
      }
    }
    dists.sort(function (a, b) { return a - b; });
    itemDists.sort(function (a, b) { return a - b; });
    var mean = dists.reduce(function (a, b) { return a + b; }, 0) / (dists.length || 1);
    var itemMean = itemDists.reduce(function (a, b) { return a + b; }, 0) / (itemDists.length || 1);
    var out = {
      map: World.mapId, sizeScale: World.sizeScale, mapSize: size,
      landKm2: +km2.toFixed(2), towns: World.towns.length,
      lootPoints: World.lootPoints.length,
      chests: chests.length,
      trees: World.treeSpots.length,
      colliders: World.colliders.length,
      props: (function () {
        var n = 0;
        World.group.traverse(function (o) { if (o.isInstancedMesh) n += o.count; });
        return n;
      })(),
      lootPerKm2: +(World.lootPoints.length / km2).toFixed(1),
      chestPerKm2: +(chests.length / km2).toFixed(1),
      itemBudget: Math.round(CONFIG.MAX_GROUND_ITEMS * Math.max(1, World.contentScale)),
      liveItems: live.length,
      liveItemsApi: Loot.count,
      itemPerKm2: +(live.length / km2).toFixed(1),
      itemTownShare: +(inTownItems / (live.length || 1)).toFixed(2),
      fieldKm2: +fieldKm2.toFixed(2),
      fieldItems: live.length - inTownItems,
      fieldItemPerKm2: +((live.length - inTownItems) / (fieldKm2 || 1)).toFixed(1),
      nearestItemMean: +itemMean.toFixed(1),
      wantChests: Math.round(CONFIG.CHEST_COUNT * Math.max(1, World.contentScale)),
      chestsField: fieldChests,
      treesPerKm2: +(World.treeSpots.length / km2).toFixed(1),
      colliderPerKm2: +(World.colliders.length / km2).toFixed(0),
      nearestChestMean: +mean.toFixed(1),
      nearestChestP90: +(dists[Math.floor(dists.length * 0.9)] || 0).toFixed(1),
      drawn: (function () {
        try { App.renderer.render(App.scene, App.camera); return App.renderer.info.render.calls; }
        catch (e) { return -1; }
      })()
    };
    return out;
  })()`;

  const isle = await evaluate(measure('isle'));
  const surf = await evaluate(measure('surf'));
  console.log('  isle: ' + JSON.stringify(isle));
  console.log('  surf: ' + JSON.stringify(surf));

  const rel = k => +(isle[k] / (surf[k] || 1)).toFixed(2);
  console.log('  isle/surf ratios: chests ' + rel('chestPerKm2') + ', loot ' + rel('lootPerKm2') +
    ', trees ' + rel('treesPerKm2') + ', colliders ' + rel('colliderPerKm2') +
    ', nearest-chest ' + rel('nearestChestMean'));

  /* The two maps are the same game, so a player (or a bot) on the big one has to
     meet roughly the same number of chests per square kilometre, and the nearest
     chest has to be about as far away. 0.75 is the "close enough" bar: the big
     island is hand-shaped with wide dunes and an ice cap, so it cannot be exactly
     equal, but it must not be half as rich. */
  check('the big island is not sparser than the small one (chest density)',
    rel('chestPerKm2') > 0.75,
    isle.chestPerKm2 + ' vs ' + surf.chestPerKm2 + ' chests/km2 (' + rel('chestPerKm2') + 'x)');
  check('the nearest chest is not further away on the big island',
    isle.nearestChestMean < surf.nearestChestMean * 1.35,
    isle.nearestChestMean + ' m vs ' + surf.nearestChestMean + ' m');
  check('ground loot is spread just as thickly',
    rel('lootPerKm2') > 0.75,
    isle.lootPerKm2 + ' vs ' + surf.lootPerKm2 + ' items/km2');
  /* The instance pools are built before a match picks its map, so this is the
     check that catches a pool sized from the wrong world: on ISLE ROYALE a match
     used to place 288 of the 1040 chests it wanted, every one of them inside the
     first towns in the list. */
  check('a match on the big island can hide the chests it wants',
    isle.chests >= isle.wantChests * 0.7,
    isle.chests + ' of ' + isle.wantChests + ' wanted (' + surf.chests + ' of ' + surf.wantChests + ' on Surf City)');
  check('chests are not all piled into the towns on the big island',
    isle.chestsField > isle.chests * 0.15,
    isle.chestsField + ' of ' + isle.chests + ' chests stand out in the field');
  check('the big island fills its ground-loot budget',
    isle.liveItems >= isle.itemBudget * 0.95 && isle.liveItemsApi === isle.liveItems,
    isle.liveItems + ' live items of a ' + isle.itemBudget + ' budget (Surf City ' +
    surf.liveItems + ' of ' + surf.itemBudget + ')');
  check('ground loot is just as thick on the big island',
    rel('itemPerKm2') > 0.75,
    isle.itemPerKm2 + ' vs ' + surf.itemPerKm2 + ' live items/km2');
  check('ground loot still reaches the towns on the big island',
    isle.itemTownShare > surf.itemTownShare * 0.6,
    'isle ' + isle.itemTownShare + ' vs surf ' + surf.itemTownShare + ' of the ground items inside a town pad');
  check('the open island is not stripped of loot',
    rel('fieldItemPerKm2') > 0.75 && isle.nearestItemMean < surf.nearestItemMean * 1.35,
    isle.fieldItemPerKm2 + ' vs ' + surf.fieldItemPerKm2 + ' field items/km2, nearest item ' +
    isle.nearestItemMean + ' m vs ' + surf.nearestItemMean + ' m');
  check('the big island is still inside the draw-call budget', isle.drawn > 0 && isle.drawn < 400,
    isle.drawn + ' calls / ' + isle.props + ' prop instances');
};
