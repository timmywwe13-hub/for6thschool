// Focused probe: is the REBUILT ISLE ROYALE actually a faithful island?
//
// The traced data (coastline, lakes, biomes, sites, roads) lands in the game as
// generated constants, and every one of them can be right in the picture and
// wrong in the world - a mis-scaled lattice, a site left in the sea, a road
// running over a lake, a snow biome painted on the beach. So this probe builds
// the island itself and asks the world, not the tables:
//
//   * the picture's 507x509 art is calibrated to the world (ISLE_ART)
//   * all nine sites stand on dry land at the pad height they were given
//   * every road sample is on land
//   * the lakes and rivers the trace found are carved below sea level, and a
//     point far from any water is above it
//   * the biome lattice reads as snow in the north, sand in the west and green
//     in the middle, i.e. the classifier survived the round trip
//   * loot, chests, trees and props all scale with the 2x-linear world
//   * the reference art actually arrives over file:// (the base64 sidecar) and
//     is painted into the map canvas
//
// It prints the whole shape of the island either way, so a regression shows up
// as numbers before it shows up as a screenshot.
//
//   node cdp-test.js _isleprobe
const fs = require('fs');
const path = require('path');

module.exports = async function isleprobe(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  shot ' + name + '.png (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
  }

  const res = await evaluate(`(function () {
    var out = {};
    World.build(QUALITY_PRESETS.high, 20260925, 'isle');
    App.state = 'PLAYING';

    out.mapId = World.mapId;
    out.mapSize = World.mapSize; out.mapRadius = World.mapRadius;
    out.mapBound = World.mapBound; out.sizeScale = World.sizeScale;
    out.artK = ISLE_ART.k; out.artWH = [ISLE_ART.w, ISLE_ART.h];
    out.artCxCy = [ISLE_ART.cx, ISLE_ART.cy];
    out.terrainSegs = World.hN; out.hStep = +World.hStep.toFixed(2);
    out.roads = World.roads.length;
    out.islets = ISLE_ISLETS.length;
    out.shoreSamples = ISLE_SHORE.length;
    out.grids = { biome: [ISLE_BIOME.length, ISLE_BIOME[0].length],
                  depth: [ISLE_DEPTH.length, ISLE_DEPTH[0].length],
                  valley: [ISLE_VALLEY.length, ISLE_VALLEY[0].length] };

    /* ---- sites: on land, on their pad, at their analytic height ---- */
    out.towns = World.towns.map(function (t) {
      return { name: t.name, x: +t.x.toFixed(1), z: +t.z.toFixed(1),
               r: +t.r.toFixed(1), y: +t.y.toFixed(2),
               ground: +World.heightAt(t.x, t.z).toFixed(2),
               buildings: t.buildings.length };
    });
    out.sitesDry = out.towns.filter(function (t) { return t.ground > 1.2; }).length;
    out.sitesPadOk = out.towns.filter(function (t) {
      return Math.abs(t.ground - t.y) < 1.6;
    }).length;

    /* ---- roads: every point of every road has to be somewhere a road can be -
       meaning on land, or on a bridge deck laid over the water. The picture draws
       its own paths across lakes, so a crossing is expected; an UNBRIDGED one is
       the defect. A creek is 1-2 picture pixels across (~3-7 m in the world) and
       the relaxer bends the road around those, so no wet run should survive at all
       outside a deck. ---- */
    var overWater = 0, samples = 0, lowest = 99, wetByLine = [],
        vertsWet = 0, verts = 0, longestRun = 0, runsAll = [];
    /* is this spot on a bridge deck? (each deck is the polyline of the road it
       carries, so a point is on it when it is within half a deck-width of any of
       its segments) */
    var onDeck = function (x, z) {
      for (var i = 0; i < World.bridges.length; i++) {
        var g = World.bridges[i], pts = g.pts, half = g.w / 2 + 1;
        for (var k = 0; k + 1 < pts.length; k++) {
          var ax = pts[k][0], az = pts[k][1];
          var bx = pts[k + 1][0], bz = pts[k + 1][1];
          var dx = bx - ax, dz = bz - az;
          var L2 = dx * dx + dz * dz;
          if (L2 < 1e-9) continue;
          var t = ((x - ax) * dx + (z - az) * dz) / L2;
          if (t < 0 || t > 1) continue;
          var px2 = ax + dx * t, pz2 = az + dz * t;
          if (Math.hypot(x - px2, z - pz2) <= half) return true;
        }
      }
      return false;
    };
    for (var v = 0; v < World.roads.length; v++) {
      verts += World.roads[v].length;
      for (var vi = 0; vi < World.roads[v].length; vi++) {
        var vx = World.roads[v][vi][0], vz = World.roads[v][vi][1];
        if (World.heightAt(vx, vz) < 1.1 && !onDeck(vx, vz)) vertsWet++;
      }
    }
    for (var r = 0; r < World.roads.length; r++) {
      var line = World.roads[r], wetHere = 0, run = 0, flat = [];
      for (var i = 0; i < line.length; i++) {
        var nxt = (i + 1 < line.length) ? line[i + 1] : null;
        var segLen = nxt ? Math.hypot(nxt[0] - line[i][0], nxt[1] - line[i][1]) : 0;
        var per = segLen / 12;
        for (var k = 0; k < 12; k++) {
          var t2 = k / 12;
          var x = line[i][0], z = line[i][1];
          if (nxt) {
            x = line[i][0] + (nxt[0] - line[i][0]) * t2;
            z = line[i][1] + (nxt[1] - line[i][1]) * t2;
          }
          var h = World.heightAt(x, z);
          var decked = onDeck(x, z);
          samples++;
          if (h < 0.6 && !decked) {
            overWater++; wetHere++; run += per;
            if (run > longestRun) longestRun = run;
          } else {
            run = 0;
          }
          if (h < lowest) lowest = h;
          flat.push([x, z, h, per, decked]);
        }
      }
      wetByLine.push(wetHere);
      /* the individual crossings, so a failure says WHERE the road went in. A
         sample that is on a deck is not a crossing, so the runs are the wet
         stretches left over - exactly what the check cares about. */
      var cur = null;
      for (var s = 0; s < flat.length; s++) {
        if (flat[s][2] < 0.6 && !flat[s][4]) {
          if (!cur) cur = { road: r, len: 0, minY: 99, x0: flat[s][0], z0: flat[s][1],
                            x1: flat[s][0], z1: flat[s][1] };
          cur.len += flat[s][3];
          cur.minY = Math.min(cur.minY, flat[s][2]);
          cur.x1 = flat[s][0]; cur.z1 = flat[s][1];
        } else if (cur) { runsAll.push(cur); cur = null; }
      }
      if (cur) runsAll.push(cur);
    }
    runsAll.sort(function (a, b) { return b.len - a.len; });
    out.roadWetRuns = runsAll.length;
    out.roadUnbridgedRuns = runsAll.length;
    out.roadWorstRuns = runsAll.slice(0, 5)
      .map(function (q) {
        var uu = Math.hypot(q.x0, q.z0) / isleShoreR(Math.atan2(q.z0, q.x0));
        return { road: q.road, len: +q.len.toFixed(1), minY: +q.minY.toFixed(2),
                 from: [Math.round(q.x0), Math.round(q.z0)],
                 to: [Math.round(q.x1), Math.round(q.z1)], u: +uu.toFixed(2),
                 art: [Math.round(islePictureX(q.x0)), Math.round(islePictureY(q.z0)),
                       Math.round(islePictureX(q.x1)), Math.round(islePictureY(q.z1))] };
      });
    out.bridges = World.bridges.map(function (g) {
      var p0 = g.pts[0], p1 = g.pts[g.pts.length - 1], len = 0;
      for (var k = 0; k + 1 < g.pts.length; k++) {
        len += Math.hypot(g.pts[k + 1][0] - g.pts[k][0], g.pts[k + 1][1] - g.pts[k][1]);
      }
      return { len: +len.toFixed(1), y: +g.y.toFixed(2), pts: g.pts.length,
               art: [Math.round(islePictureX(p0[0])), Math.round(islePictureY(p0[1])),
                     Math.round(islePictureX(p1[0])), Math.round(islePictureY(p1[1]))] };
    });
    /* the polyline either side of the longest run: are the road's own vertices
       dry with one long segment across the lake, or is the line following water? */
    out.worstRun = (function () {
      var w = runsAll[0];
      if (!w) return null;
      var line = World.roads[w.road];
      var bestI = 0, bestD = 1e9;
      for (var i = 0; i < line.length; i++) {
        var dd = Math.hypot(line[i][0] - w.x0, line[i][1] - w.z0);
        if (dd < bestD) { bestD = dd; bestI = i; }
      }
      var o = { road: w.road, nearVertex: bestI, of: line.length, verts: [] };
      for (var k = Math.max(0, bestI - 4); k < Math.min(line.length, bestI + 5); k++) {
        o.verts.push([Math.round(islePictureX(line[k][0])), Math.round(islePictureY(line[k][1])),
                      +World.heightAt(line[k][0], line[k][1]).toFixed(1)]);
      }
      return o;
    })();
    out.roadSamples = samples; out.roadOverWater = overWater;
    out.roadLowest = +lowest.toFixed(2);
    out.roadVerts = verts; out.roadVertsWet = vertsWet;
    out.roadWetByLine = wetByLine;
    out.roadLongestWetRun = +longestRun.toFixed(1);

    /* ---- the heightmap has to span the whole world: a grid built over the
       classic 1000-unit map clamps every height outside +-500, which flattens
       the outer half of the island onto the sea floor ---- */
    out.span = { hHalf: World.hHalf, hStep: +World.hStep.toFixed(2), hN: World.hN,
                 worldSize: World.mapSize };
    out.clampTest = {
      inside: +World.heightAt(-480, 0).toFixed(2),
      atOldEdge: +World.heightAt(-500, 0).toFixed(2),
      outside: +World.heightAt(-540, 0).toFixed(2)
    };
    /* ---- direct comparison at one point well outside the coast: the analytic
       surface, the grid the collision reads, and the numbers that make them ---- */
    out.probe800 = {
      heightAt: +World.heightAt(800, 0).toFixed(2),
      shaped: +shapedHeight(800, 0).toFixed(2),
      base: +baseHeight(800, 0).toFixed(2),
      shore: +isleShoreR(0).toFixed(1),
      u: +(800 / isleShoreR(0)).toFixed(3),
      carve: +isleCarve(800, 0).toFixed(2),
      wetCut: +isleWaterCut(10, 800, 0).toFixed(2)
    };
    out.profile = (function () {
      var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]], names = ['E', 'W', 'S', 'N'];
      var o = {};
      for (var k = 0; k < dirs.length; k++) {
        var line = [];
        for (var r = 300; r <= 1400; r += 100) {
          line.push(+World.heightAt(dirs[k][0] * r, dirs[k][1] * r).toFixed(1));
        }
        o[names[k] + ':300..1400'] = line;
      }
      return o;
    })();

    /* ---- water: what the trace called water INSIDE the coast has to be under
       the sea, and the deep interior must not be. Cells outside the traced coast
       are the sea already, so they are not part of this test. ---- */
    var wetInland = [], dryH = [], deepest = null;
    for (var j = 0; j < 64; j++) {
      for (var i2 = 0; i2 < 64; i2++) {
        var d = ISLE_DEPTH[j].charCodeAt(i2) - 48;
        var v = ISLE_VALLEY[j].charCodeAt(i2) - 48;
        var px2 = (i2 + 0.5) / 64 * ISLE_ART.w, py = (j + 0.5) / 64 * ISLE_ART.h;
        var wx = isleWorldX(px2), wz = isleWorldZ(py);
        var h2 = World.heightAt(wx, wz);
        var u = Math.hypot(wx, wz) / isleShoreR(Math.atan2(wz, wx));
        if (u < 0.95 && d >= 2) {
          wetInland.push(h2);
          if (!deepest || d > deepest.depth) {
            deepest = { depth: d, px: +px2.toFixed(1), py: +py.toFixed(1),
                        carve: +isleCarve(wx, wz).toFixed(2),
                        base: +baseHeight(wx, wz).toFixed(2),
                        heightAt: +h2.toFixed(2) };
          }
        }
        if (v <= 4 && d === 0 && u < 0.95) dryH.push(h2);
      }
    }
    var avg = function (a) {
      var s = 0; for (var i = 0; i < a.length; i++) s += a[i];
      return a.length ? s / a.length : 0;
    };
    var minOf = function (a) { return a.length ? Math.min.apply(null, a) : 0; };
    var maxOf = function (a) { return a.length ? Math.max.apply(null, a) : 0; };
    out.deepCell = deepest;
    out.lakeCells = wetInland.length; out.lakeAvgH = +avg(wetInland).toFixed(2);
    out.lakeFlooded = wetInland.filter(function (h) { return h < -0.4; }).length;
    out.lakeMinH = +minOf(wetInland).toFixed(2);
    out.lakeMaxH = +maxOf(wetInland).toFixed(2);
    out.dryCells = dryH.length; out.dryAvgH = +avg(dryH).toFixed(2);
    out.dryAboveSea = dryH.filter(function (h) { return h > 0.5; }).length;

    /* ---- biomes read back off the world ----
       The three sample points are the centres of 3x3 identical, dry lattice
       cells, read straight off the generated grid, so this checks the reader's
       row/column mapping against the picture rather than a guess about which
       corner of the art is the ice cap (the picture's snow, sand and green are
       interleaved patches, not north/south/west bands). */
    var at = function (px, py) {
      var b = isleBiomeAt(isleWorldX(px), isleWorldZ(py));
      return { green: +b.green.toFixed(2), sand: +b.sand.toFixed(2),
               snow: +b.snow.toFixed(2) };
    };
    out.biomeSnow = at(279.9, 206.8);   // picture pixel reads 212,226,237 - ice
    out.biomeSand = at(216.5, 270.4);   // picture pixel reads 164,146,74  - dune
    out.biomeGreen = at(269.3, 259.8);  // picture pixel reads 102,148,73  - grass
    out.biomeTotals = (function () {
      var g = 0, s = 0, n = 0;
      for (var j2 = 0; j2 < 48; j2++) {
        for (var i3 = 0; i3 < 48; i3++) {
          var v2 = ISLE_BIOME[j2].charCodeAt(i3) - 48;
          if (v2 === 1) s++; else if (v2 === 2) n++; else g++;
        }
      }
      return { green: g, sand: s, snow: n };
    })();

    /* ---- content scaled with the world ----
       chests only exist once the match fills them in, so do what a match does */
    out.lootPoints = World.lootPoints.length;
    Loot.initChests(App.scene);
    out.chestsPlaced = Loot.populateChests();
    out.chests = Loot.chestCount();
    out.trees = World.treeSpots.length;
    out.props = World.propSpots ? World.propSpots.length : -1;
    out.colliders = World.colliders.length;
    out.platforms = World.platforms.length;

    /* ---- zone + bus are sized for the big island ---- */
    Zone.reset();
    out.zoneStart = +Zone.cur.r.toFixed(1);
    out.zoneNext = +Zone.next.r.toFixed(1);
    out.zonePhases = CONFIG.ZONE_PHASES.length;
    Bus.buildRoute();
    out.busLen = +Bus.len.toFixed(0);
    out.busStart = [+Bus.x0.toFixed(0), +Bus.z0.toFixed(0)];

    /* ---- draw calls / sim cost on the real island ---- */
    var t0 = performance.now();
    for (var i4 = 0; i4 < 120; i4++) Game.update(1 / 60);
    var t1 = performance.now();
    Game.render(1 / 60);
    out.updateMsPerFrame = +((t1 - t0) / 120).toFixed(2);
    out.drawCalls = App.renderer.info.render.calls;
    out.triangles = App.renderer.info.render.triangles;

    /* ---- the reference art: sidecar -> data URL -> map canvas ----
       the load is async, so the art itself is read back after a sleep below */
    return out;
  })()`);

  /* The sidecar <script> and the image decode are both async, so poll for it: over
     file:// this is the base64 fallback path, which is the one the tests run on.
     State only, no canvas readback - the pixels are sampled once at the end. */
  let art = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    await sleep(attempt ? 500 : 900);
    art = await evaluate(`(function () {
      var names = [];
      var ts = document.getElementsByTagName('script');
      for (var i = 0; i < ts.length; i++) {
        if (ts[i].src && ts[i].src.indexOf('isle_map') >= 0) {
          names.push(String(ts[i].src).split('/').pop());
        }
      }
      return {
        state: MapArt.state(), ready: MapArt.ready(),
        src: MapArt.ready() ? String(MapArt.image().src).slice(0, 22) : '',
        dataUrl: !!(MapArt.ready() &&
          MapArt.image().src.indexOf('data:image/png;base64,') === 0),
        natural: MapArt.ready()
          ? [MapArt.image().naturalWidth, MapArt.image().naturalHeight] : [0, 0],
        b64Chars: window.ISLE_MAP_B64 ? window.ISLE_MAP_B64.length : 0,
        canvas: World.mapCanvas ? [World.mapCanvas.width, World.mapCanvas.height] : [0, 0],
        tags: names
      };
    })()`);
    if (art.ready) break;
  }
  if (!art.ready) console.log('  art never arrived: ' + JSON.stringify(art));
  /* one readback for every sample: repeated getImageData() on one canvas is slow
     AND the browser logs a willReadFrequently warning about it */
  const pixels = await evaluate(`(function () {
    var mg = World.mapCanvas.getContext('2d');
    var cw = World.mapCanvas.width, ch = World.mapCanvas.height;
    var all = mg.getImageData(0, 0, cw, ch).data;
    var px = function (wx, wz) {
      var p = World.mapPoint(wx, wz);
      var ix = Math.max(0, Math.min(cw - 1, Math.round(p.x)));
      var iy = Math.max(0, Math.min(ch - 1, Math.round(p.y)));
      var o = (iy * cw + ix) * 4;
      return [all[o], all[o + 1], all[o + 2]];
    };
    return {
      /* the ice cap: white in the picture, and at worst grey rock in the fallback
         bands - so a bright pixel here can only be the art */
      icePixel: px(isleWorldX(300), isleWorldZ(60)),
      /* mid-ocean, outside the coast: the art's own sea colour */
      seaPixel: px(isleWorldX(20), isleWorldZ(240)),
      centrePixel: px(0, 0)
    };
  })()`);
  art.icePixel = pixels.icePixel;
  art.seaPixel = pixels.seaPixel;
  art.centrePixel = pixels.centrePixel;

  console.log('  isle shape: ' + JSON.stringify({
    mapSize: res.mapSize, mapRadius: res.mapRadius, mapBound: res.mapBound,
    sizeScale: res.sizeScale, terrainSegs: res.terrainSegs, hStep: res.hStep,
    roads: res.roads, islets: res.islets, shoreSamples: res.shoreSamples,
    grids: res.grids
  }));
  console.log('  art: ' + JSON.stringify({
    k: res.artK, w: res.artWH[0], h: res.artWH[1], centre: res.artCxCy,
    state: art.state, ready: art.ready, src: art.src, dataUrl: art.dataUrl,
    natural: art.natural, b64Chars: art.b64Chars, canvas: art.canvas,
    icePixel: art.icePixel, centrePixel: art.centrePixel, seaPixel: art.seaPixel
  }));
  console.log('  sites: ' + JSON.stringify(res.towns));
  console.log('  span: ' + JSON.stringify(res.span) + ' clampTest: ' +
    JSON.stringify(res.clampTest));
  console.log('  profile (outward every 100 units): ' + JSON.stringify(res.profile));
  console.log('  probe800: ' + JSON.stringify(res.probe800));
  console.log('  worst wet runs: ' + JSON.stringify(res.roadWorstRuns));
  console.log('  bridges: ' + JSON.stringify(res.bridges));
  console.log('  worst run context: ' + JSON.stringify(res.worstRun));
  console.log('  water: ' + JSON.stringify({
    lakeCells: res.lakeCells, lakeAvgH: res.lakeAvgH, flooded: res.lakeFlooded,
    lakeMinH: res.lakeMinH, lakeMaxH: res.lakeMaxH,
    dryCells: res.dryCells, dryAvgH: res.dryAvgH, dryAboveSea: res.dryAboveSea
  }));
  console.log('  deepest inland water: ' + JSON.stringify(res.deepCell));
  console.log('  biome: ' + JSON.stringify({
    snow: res.biomeSnow, sand: res.biomeSand, green: res.biomeGreen,
    lattice: res.biomeTotals
  }));
  console.log('  content: ' + JSON.stringify({
    lootPoints: res.lootPoints, chests: res.chests, chestsPlaced: res.chestsPlaced,
    trees: res.trees, props: res.props, colliders: res.colliders,
    platforms: res.platforms
  }));
  console.log('  budget: ' + JSON.stringify({
    drawCalls: res.drawCalls, triangles: res.triangles,
    updateMsPerFrame: res.updateMsPerFrame,
    zoneStart: res.zoneStart, zoneNext: res.zoneNext, zonePhases: res.zonePhases,
    busLen: res.busLen
  }));

  /* the picture is 507x509 and ISLE_ART maps it onto the 2000-unit world */
  check('the island is twice Surf City across, four times its area',
    res.mapSize === 2000 && res.mapRadius === 850 && res.sizeScale === 2,
    res.mapSize + ' units / radius ' + res.mapRadius + ' / scale ' + res.sizeScale);
  check('the picture art is calibrated to the world',
    res.artWH[0] === 507 && res.artWH[1] === 509 && res.artK > 3 && res.artK < 4,
    res.artWH.join('x') + ' at ' + res.artK + ' units/px');
  check('the lattices keep one string per row',
    res.grids.biome[1] === 48 && res.grids.depth[1] === 64 && res.grids.valley[1] === 64,
    JSON.stringify(res.grids));
  check('all nine sites stand on dry land', res.sitesDry === 9,
    res.sitesDry + '/9 sites above the waterline');
  check('every site sits on the pad it was given', res.sitesPadOk === 9,
    res.sitesPadOk + '/9 within 1.6 units of their pad');
  check('the downtown is the big one',
    res.towns.filter(function (t) { return t.buildings > 20; }).length === 1,
    res.towns.map(function (t) { return t.name + ':' + t.buildings; }).join(' '));
  check('the heightmap spans the whole world',
    res.span.hHalf === res.span.worldSize / 2 &&
    Math.abs(res.span.hStep * res.span.hN - res.span.worldSize) < 0.5,
    'grid ' + res.span.hN + ' x ' + res.span.hStep + ' = ' +
    (res.span.hStep * res.span.hN).toFixed(1) + ' over a ' + res.span.worldSize +
    '-unit world');
  check('terrain outside the classic map is real terrain, not a clamp',
    res.clampTest.outside !== res.clampTest.atOldEdge,
    'y ' + res.clampTest.inside + ' at -480, ' + res.clampTest.atOldEdge +
    ' at the old 500 boundary and ' + res.clampTest.outside + ' past it');
  check('the traced roads keep every vertex out of open water',
    res.roadVertsWet === 0,
    res.roadVertsWet + '/' + res.roadVerts + ' road vertices wet and unbridged');
  check('every stretch of road that crosses water has a bridge over it',
    res.roadUnbridgedRuns === 0 && res.roadLongestWetRun < 12,
    res.roadWetRuns + ' wet run(s), ' + res.roadUnbridgedRuns + ' unbridged; ' +
    (100 * res.roadOverWater / res.roadSamples).toFixed(1) + '% of samples wet, ' +
    'longest unbridged run ' + res.roadLongestWetRun + ' m, lowest y ' +
    res.roadLowest + ', per road ' + JSON.stringify(res.roadWetByLine) +
    '; bridges ' + JSON.stringify(res.bridges));
  check('the traced lakes are carved below sea level',
    res.lakeCells > 20 && res.lakeFlooded / res.lakeCells > 0.8,
    res.lakeFlooded + '/' + res.lakeCells + ' inland water cells flooded (y ' +
    res.lakeMinH + '..' + res.lakeMaxH + ', avg ' + res.lakeAvgH + ')');
  check('the dry interior is above sea level',
    res.dryCells > 0 && res.dryAboveSea / res.dryCells > 0.9,
    res.dryAboveSea + '/' + res.dryCells + ' dry cells above sea, avg y ' + res.dryAvgH);
  check('the snow patch reads as snow', res.biomeSnow.snow > 0.5,
    JSON.stringify(res.biomeSnow));
  check('the dune patch reads as sand', res.biomeSand.sand > 0.5,
    JSON.stringify(res.biomeSand));
  check('the grass patch reads as green', res.biomeGreen.green > 0.5,
    JSON.stringify(res.biomeGreen));
  check('every lattice cell carries a biome',
    res.biomeTotals.green + res.biomeTotals.sand + res.biomeTotals.snow === 48 * 48,
    JSON.stringify(res.biomeTotals));
  check('loot scales with the world', res.lootPoints > 200, res.lootPoints + ' loot spots');
  check('chests scale with the world', res.chests > 260,
    res.chests + ' chests placed on the island');
  check('trees scale with the world', res.trees > 400, res.trees + ' trees');
  /* CONFIG.ZONE_START_R is 470 and the first shrink target 400: both scale with
     mapRadius, so on the 850-radius island they come out at 940 and 800 */
  check('the zone opens across the whole island',
    Math.abs(res.zoneStart - 940) < 25 && Math.abs(res.zoneNext - 800) < 25,
    'start ' + res.zoneStart + ' -> first shrink ' + res.zoneNext +
    ' over ' + res.zonePhases + ' phases');
  /* the classic route is 2 x WORLD_BOUND x 1.35 = 1328 units; the big island's
     is twice that, and the bus flies twice as fast to match */
  check('the bus route clears the bigger island', res.busLen > 2400,
    res.busLen + ' units from ' + JSON.stringify(res.busStart));
  check('the reference art loads over file:// and is a data URL',
    art.ready === true && art.dataUrl === true && art.natural[0] === 507,
    art.state + ', ' + art.b64Chars + ' base64 chars, ' + art.natural.join('x'));
  check('the map canvas is painted from the reference art',
    (art.icePixel[0] + art.icePixel[1] + art.icePixel[2]) / 3 > 150,
    'ice cap pixel ' + JSON.stringify(art.icePixel) + ' (fallback bands cap at ~124)');
  check('the island still renders inside the draw-call budget', res.drawCalls < 400,
    res.drawCalls + ' calls / ' + res.triangles + ' tris');
  check('the island simulates inside the frame budget', res.updateMsPerFrame < 8,
    res.updateMsPerFrame + ' ms/frame');

  /* the in-game map art, straight off the canvas the HUD draws from */
  const mapPng = await evaluate(`World.mapCanvas.toDataURL('image/png')`);
  fs.writeFileSync(path.join(OUT, 'isleprobe-map.png'),
    Buffer.from(mapPng.split(',')[1], 'base64'));
  console.log('  wrote playtest/isleprobe-map.png (the in-game map art)');

  /* and an aerial of the island itself, from high enough to see all 1700 units
     of it: the sim loop is paused so the camera is what gets rendered */
  await evaluate(`(function () {
    document.getElementById('startScreen').classList.add('hidden');
    App.paused = true;
    App.showScreen(null);
    window.__fog = App.scene.fog || null;
    App.scene.fog = null;
    const cam = App.camera;
    cam.position.set(0, 1750, 1950);
    cam.rotation.set(-0.72, 0, 0);
    cam.far = Math.max(cam.far, 6000);
    cam.updateProjectionMatrix();
    return cam.position.y;
  })()`);
  await sleep(600);
  await shot('isleprobe-aerial');

  /* and one close-up of the longest bridge, from just above the water: the deck,
     its kerbs and its piers are the newest geometry on the map, and the only way
     to know a bridge is a bridge is to look at one */
  const bridgeView = await evaluate(`(function () {
    var g = null;
    for (var i = 0; i < World.bridges.length; i++) {
      var b = World.bridges[i], len = 0;
      for (var k = 0; k + 1 < b.pts.length; k++) {
        len += Math.hypot(b.pts[k + 1][0] - b.pts[k][0], b.pts[k + 1][1] - b.pts[k][1]);
      }
      if (!g || len > g.len) g = { b: b, len: len };
    }
    if (!g) return null;
    var p0 = g.b.pts[0], p1 = g.b.pts[g.b.pts.length - 1];
    var mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
    var dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    var L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    var cam = App.camera;
    cam.position.set(mx - dx * 70 - dz * 42, g.b.y + 26, mz - dz * 70 + dx * 42);
    cam.lookAt(new THREE.Vector3(mx, g.b.y, mz));
    cam.far = Math.max(cam.far, 6000);
    cam.updateProjectionMatrix();
    return { len: Math.round(L), y: +g.b.y.toFixed(2) };
  })()`);
  await sleep(600);
  await shot('isleprobe-bridge');
  console.log('  longest bridge close-up: ' + JSON.stringify(bridgeView));
};
