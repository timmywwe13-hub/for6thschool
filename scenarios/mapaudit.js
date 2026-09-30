// Map integrity audit: holes, seams, water edges and foundations.
//
// The repair pass this guards was made against the built world, not the tables:
// a heightmap with a NaN vertex, a mesh whose triangles are split differently
// from the ones the collision query stands on, a "lake" cell the art draws over
// walkable sand, a building whose foundation floats above a dip in its own
// footprint, a bridge end that is a two-metre mantle off the bank, an islet the
// picture draws that never got raised - all of those are invisible in the data
// and obvious in the world. So this builds ISLE ROYALE and asks it:
//
//   * the heightmap is finite everywhere and the drawn mesh uses the SAME
//     lattice and the SAME quad diagonal the collision reader assumes
//   * the picture's water cells hold water and its land cells are dry
//   * every town, building, bridge bank, tree and loot point is reachable on
//     foot from the middle of the island (no holes you fall in, no pockets you
//     cannot climb out of)
//   * every foundation meets the ground under it, and every bridge end is
//     within a jump of its bank
//   * the invisible wall stands in open water, no land lies outside it, and
//     World.rescueFromVoid lifts a body dropped 40 m under the world
//
//   node cdp-test.js mapaudit
module.exports = async function mapaudit(ctx) {
  const { evaluate, check } = ctx;

  const res = await evaluate(`(function () {
    var out = {};
    var SEA = CONFIG.SEA_LEVEL;
    World.build(QUALITY_PRESETS.high, 20260926, 'isle');
    App.state = 'PLAYING';

    /* ================= 1. the heightmap itself ================= */
    var H = World.height, n = World.hN + 1;
    var nan = 0, minH = 1e9, maxH = -1e9;
    for (var i = 0; i < H.length; i++) {
      var v = H[i];
      if (!isFinite(v)) nan++;
      else { if (v < minH) minH = v; if (v > maxH) maxH = v; }
    }
    out.height = { verts: H.length, nan: nan, min: +minH.toFixed(2), max: +maxH.toFixed(2),
      segs: World.hN, step: +World.hStep.toFixed(3), span: +(World.hStep * World.hN).toFixed(1),
      world: World.mapSize };

    /* ================= 2. mesh vs collision: one lattice, one diagonal =================
       heightAtTriangle() assumes each quad is split along the (i,j+1)-(i+1,j)
       diagonal - the split THREE.PlaneGeometry writes. If a future mesh (a
       skirt, a chunked LOD, a rotated grid) ever splits differently, the visible
       surface and the surface the player stands on drift apart: you wade
       through hillsides or float on air. So read the LIVE index buffer. */
    var geo = World.terrain.geometry, pos = geo.attributes.position, idx = geo.index;
    var quads = 0, wrongSplit = 0, worstVertex = 0, maxDev = 0, devAt = null;
    var gx1 = World.hN + 1;
    function triY(pa, pb, pc, x, z) {
      /* barycentric height of the triangle (pa,pb,pc) at (x,z) */
      var ax = pos.getX(pa), az = pos.getZ(pa), ay = pos.getY(pa);
      var bx = pos.getX(pb), bz = pos.getZ(pb), by = pos.getY(pb);
      var cx = pos.getX(pc), cz = pos.getZ(pc), cy = pos.getY(pc);
      var d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) return ay;
      var l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      var l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      return l1 * ay + l2 * by + (1 - l1 - l2) * cy;
    }
    for (var q = 0; q < 400; q++) {
      var ci = Math.floor(Math.random() * (World.hN - 1));
      var cj = Math.floor(Math.random() * (World.hN - 1));
      var base = 6 * (cj * World.hN + ci);
      var a = ci + gx1 * cj, b = ci + gx1 * (cj + 1),
          c = (ci + 1) + gx1 * (cj + 1), d2 = (ci + 1) + gx1 * cj;
      quads++;
      /* PlaneGeometry writes (a,b,d) then (b,c,d) for every cell */
      if (idx.getX(base) !== a || idx.getX(base + 1) !== b || idx.getX(base + 2) !== d2 ||
          idx.getX(base + 3) !== b || idx.getX(base + 4) !== c || idx.getX(base + 5) !== d2) wrongSplit++;
      /* vertex positions must sit exactly on the heightmap lattice */
      var lat = [[a, ci, cj], [b, ci, cj + 1], [c, ci + 1, cj + 1], [d2, ci + 1, cj]];
      for (var w = 0; w < 4; w++) {
        var id = lat[w][0], ii = lat[w][1], jj = lat[w][2];
        var ex = -World.hHalf + ii * World.hStep, ez = -World.hHalf + jj * World.hStep;
        var dv = Math.max(Math.abs(pos.getX(id) - ex), Math.abs(pos.getZ(id) - ez),
                          Math.abs(pos.getY(id) - H[jj * n + ii]));
        if (dv > worstVertex) worstVertex = dv;
      }
      /* the drawn surface at a random point of the quad vs the collision surface */
      var fx = 0.2 + Math.random() * 0.7, fz = 0.2 + Math.random() * 0.7;
      var x = -World.hHalf + (ci + fx) * World.hStep;
      var z = -World.hHalf + (cj + fz) * World.hStep;
      var hc = World.heightAt(x, z);
      var hm = (fx + fz <= 1) ? triY(a, d2, b, x, z) : triY(b, c, d2, x, z);
      var dev = Math.abs(hm - hc);
      if (dev > maxDev) { maxDev = dev; devAt = { x: Math.round(x), z: Math.round(z), mesh: +hm.toFixed(2), coll: +hc.toFixed(2) }; }
    }
    out.mesh = { quads: quads, wrongSplit: wrongSplit, worstVertex: worstVertex,
      maxDev: maxDev, devAt: devAt, verts: pos.count, index: idx.count,
      expectedVerts: n * n, expectedIndex: World.hN * World.hN * 6 };

    /* ================= 3. water table: the art's lakes hold water =================
       The depth lattice is the picture's own grid (64x64), so a cell whose four
       corners are all water IS a cell the map art draws as water. Sample the
       world at the centre of every such cell: it has to be under the sea, or the
       world has a walkable "dry lake" the player can stand in while the map
       shows water. The mirror case - a cell whose four corners are all dry but
       whose ground is below sea level - is landlocked water on dry land. Cells on
       the water's edge are the bank and are skipped: the cut ramps, by design. */
    var NC = 64;
    var dryLakes = [], dryLakeN = 0, floodLand = [], floodLandN = 0;
    var waterCells = 0, dryCells = 0;
    for (var ci2 = 0; ci2 < NC - 1; ci2++) {
      for (var cj2 = 0; cj2 < NC - 1; cj2++) {
        var d0 = ISLE_DEPTH[cj2].charCodeAt(ci2) - 48;
        var d1 = ISLE_DEPTH[cj2].charCodeAt(ci2 + 1) - 48;
        var d2 = ISLE_DEPTH[cj2 + 1].charCodeAt(ci2) - 48;
        var d3 = ISLE_DEPTH[cj2 + 1].charCodeAt(ci2 + 1) - 48;
        var allWet = d0 > 0 && d1 > 0 && d2 > 0 && d3 > 0;
        var allDry = d0 === 0 && d1 === 0 && d2 === 0 && d3 === 0;
        if (!allWet && !allDry) continue;
        /* the quad between lattice nodes (i,j) and (i+1,j+1): its centre */
        var px3 = (ci2 + 1) / NC * ISLE_ART.w, py3 = (cj2 + 1) / NC * ISLE_ART.h;
        var wx2 = isleWorldX(px3), wz2 = isleWorldZ(py3);
        var hw2 = World.heightAt(wx2, wz2);
        if (allWet) {
          waterCells++;
          if (hw2 > SEA - 0.2) {
            dryLakeN++;
            if (dryLakes.length < 8) dryLakes.push({ cell: [ci2, cj2], x: Math.round(wx2), z: Math.round(wz2), h: +hw2.toFixed(2) });
          }
        } else {
          var u2 = Math.sqrt(wx2 * wx2 + wz2 * wz2) / (isleShoreR(Math.atan2(wz2, wx2)) || 1);
          if (u2 > 0.85) continue;      // the ocean is not a lake
          dryCells++;
          if (hw2 < SEA - 0.2) {
            floodLandN++;
            if (floodLand.length < 8) floodLand.push({ cell: [ci2, cj2], x: Math.round(wx2), z: Math.round(wz2), h: +hw2.toFixed(2) });
          }
        }
      }
    }
    out.water = { waterCells: waterCells, dryCells: dryCells, dryLakeN: dryLakeN, dryLakes: dryLakes,
      floodLandN: floodLandN, floodLand: floodLand };
    /* ================= 4. reachability: is every placed thing on the one island? =================
       A 4 m lattice of dry land; two neighbouring nodes connect when the step
       between them is within what a player can climb (0.62 m is a step, up to
       2.05 m is a mantle or a jump). Everything the world placed - towns,
       buildings, bridge banks, trees, loot - has to be in the same component as
       the middle of the island, and no land component big enough to hold
       content may be an enclosed pocket. */
    var G = 500, gstep = World.mapSize / G;
    var idArr = new Int32Array(G * G);
    var nx = new Float32Array(G * G), nz = new Float32Array(G * G), nh = new Float32Array(G * G);
    var total = 0;
    for (var gi = 0; gi < G; gi++) {
      for (var gj = 0; gj < G; gj++) {
        var x0 = -World.hHalf + (gi + 0.5) * gstep, z0 = -World.hHalf + (gj + 0.5) * gstep;
        var h0 = World.heightAt(x0, z0);
        idArr[gi * G + gj] = -1;
        if (h0 > SEA + 0.55) {
          idArr[gi * G + gj] = total;
          nx[total] = x0; nz[total] = z0; nh[total] = h0;
          total++;
        }
      }
    }
    var par = new Int32Array(total);
    for (var t0 = 0; t0 < total; t0++) par[t0] = t0;
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    function uni(a, b) { a = find(a); b = find(b); if (a !== b) par[b] = a; }
    var stepEdges = 0, climbEdges = 0;
    for (var gi2 = 0; gi2 < G; gi2++) {
      for (var gj2 = 0; gj2 < G; gj2++) {
        var me = idArr[gi2 * G + gj2];
        if (me < 0) continue;
        if (gi2 + 1 < G) {
          var o1 = idArr[(gi2 + 1) * G + gj2];
          if (o1 >= 0) { var d1 = Math.abs(nh[me] - nh[o1]); if (d1 <= 2.05) { uni(me, o1); if (d1 <= 0.62) stepEdges++; else climbEdges++; } }
        }
        if (gj2 + 1 < G) {
          var o2 = idArr[gi2 * G + gj2 + 1];
          if (o2 >= 0) { var d2h = Math.abs(nh[me] - nh[o2]); if (d2h <= 2.05) { uni(me, o2); if (d2h <= 0.62) stepEdges++; else climbEdges++; } }
        }
      }
    }
    function nodeIdAt(x, z) {
      var gx5 = Math.floor((x + World.hHalf) / gstep);
      var gz5 = Math.floor((z + World.hHalf) / gstep);
      if (gx5 < 0 || gz5 < 0 || gx5 >= G || gz5 >= G) return -1;
      return idArr[gx5 * G + gz5];
    }
    /* Bridges are links: a deck carries a body from one bank to the other, so for
       reachability the two banks are one landmass. Without this a canyon town
       served by a bridge reads as "trapped", and a bridge whose ends lead into
       the same bank reads as a defect. An end with no dry ground within 44 m is
       either a causeway into the shallows - the walker wades, which is fine - or
       the end of a road the picture draws into a lagoon, which is a dead end
       rather than a defect. Only an end that is neither is flagged. */
    function roadTerminus(p) {
      for (var rr2 = 0; rr2 < World.roads.length; rr2++) {
        var line2 = World.roads[rr2];
        if (Math.hypot(line2[0][0] - p[0], line2[0][1] - p[1]) < 8) return true;
        var last2 = line2[line2.length - 1];
        if (Math.hypot(last2[0] - p[0], last2[1] - p[1]) < 8) return true;
      }
      return false;
    }
    var bridgeLinks = 0, bridgeWadeOnly = 0, bridgeDeadEnd = 0, bridgeNoBank = 0, bridgeNoBankAt = [];
    for (var bl = 0; bl < World.bridges.length; bl++) {
      var bb2 = World.bridges[bl];
      function bankNode(end, prev2) {
        var ddx = end[0] - prev2[0], ddz = end[1] - prev2[1];
        var L2 = Math.hypot(ddx, ddz) || 1;
        ddx /= L2; ddz /= L2;
        for (var dd = 2; dd <= 44; dd += 2) {
          var idn = nodeIdAt(end[0] + ddx * dd, end[1] + ddz * dd);
          if (idn >= 0) return idn;
        }
        return -1;
      }
      function bankInfo(end, prev2) {
        var idn = bankNode(end, prev2);
        if (idn >= 0) return { node: idn, wade: true };
        var ddx = end[0] - prev2[0], ddz = end[1] - prev2[1];
        var L2 = Math.hypot(ddx, ddz) || 1;
        ddx /= L2; ddz /= L2;
        for (var dd2 = 2; dd2 <= 44; dd2 += 2) {
          if (World.heightAt(end[0] + ddx * dd2, end[1] + ddz * dd2) > SEA - 0.9) return { node: -1, wade: true };
        }
        return { node: -1, wade: false };
      }
      var iA = bankInfo(bb2.pts[0], bb2.pts[1]);
      var iB = bankInfo(bb2.pts[bb2.pts.length - 1], bb2.pts[bb2.pts.length - 2]);
      if (iA.node >= 0 && iB.node >= 0) { uni(iA.node, iB.node); bridgeLinks++; }
      else if (!iA.wade || !iB.wade) {
        var endAt = iA.wade ? bb2.pts[bb2.pts.length - 1] : bb2.pts[0];
        if (roadTerminus(endAt)) bridgeDeadEnd++;
        else {
          bridgeNoBank++;
          if (bridgeNoBankAt.length < 6) {
            bridgeNoBankAt.push({ y: +bb2.y.toFixed(1), a: iA.node >= 0 ? 'bank' : (iA.wade ? 'wade' : 'deep water'),
              b: iB.node >= 0 ? 'bank' : (iB.wade ? 'wade' : 'deep water'),
              at: [Math.round(bb2.pts[0][0]), Math.round(bb2.pts[0][1])] });
          }
        }
      } else bridgeWadeOnly++;
    }
    /* the component that owns the middle of the island */
    var originId = -1, bestR = 1e9;
    for (var t1 = 0; t1 < total; t1++) {
      var rr = Math.hypot(nx[t1], nz[t1]);
      if (rr < bestR) { bestR = rr; originId = t1; }
    }
    var mainRoot = find(originId);
    function compOf(x, z) {
      var id3 = nodeIdAt(x, z);
      return id3 < 0 ? -1 : find(id3);
    }
    /* component sizes, how high the wall around each one is, and which of them
       are islets in water rather than land a body can be trapped on */
    var sizes = {};
    for (var t2 = 0; t2 < total; t2++) {
      var r2 = find(t2);
      if (!sizes[r2]) sizes[r2] = { n: 0, sx: 0, sz: 0 };
      sizes[r2].n++; sizes[r2].sx += nx[t2]; sizes[r2].sz += nz[t2];
    }
    /* the tightest way out of each component: the smallest step UP to a neighbour
       outside it (a drop is free). undefined = every neighbour is water. */
    var wallMin = {};
    for (var gi4 = 0; gi4 < G; gi4++) {
      for (var gj4 = 0; gj4 < G; gj4++) {
        var a4 = idArr[gi4 * G + gj4];
        if (a4 < 0) continue;
        var ra4 = find(a4);
        var nb4 = [];
        if (gi4 + 1 < G) nb4.push(idArr[(gi4 + 1) * G + gj4]);
        if (gj4 + 1 < G) nb4.push(idArr[gi4 * G + gj4 + 1]);
        if (gi4 > 0) nb4.push(idArr[(gi4 - 1) * G + gj4]);
        if (gj4 > 0) nb4.push(idArr[gi4 * G + gj4 - 1]);
        for (var q4 = 0; q4 < nb4.length; q4++) {
          var oi4 = nb4[q4];
          if (oi4 < 0) continue;
          var ro4 = find(oi4);
          if (ro4 === ra4) continue;
          var up4 = nh[a4] - nh[oi4];
          if (wallMin[ra4] === undefined || up4 < wallMin[ra4]) wallMin[ra4] = up4;
          if (wallMin[ro4] === undefined || up4 < wallMin[ro4]) wallMin[ro4] = up4;
        }
      }
    }
    var pockets = [], comps = 0, kindCounts = {};
    var classOf = {};
    for (var key in sizes) {
      var c2 = sizes[key]; comps++;
      if (c2.n < 25) { classOf[key] = 'ledge'; kindCounts.ledge = (kindCounts.ledge || 0) + 1; continue; }
      if (String(key) === String(mainRoot)) { classOf[key] = 'main'; continue; }
      var cx2 = c2.sx / c2.n, cz2 = c2.sz / c2.n;
      var cr = Math.hypot(cx2, cz2);
      var shore = isleShoreR(Math.atan2(cz2, cx2));
      var wall = wallMin[key];
      /* water all around: reached by air, like every islet. Higher ground all
         around (a negative wall is a stepDOWN to the outside, so leaving means
         climbing it): a basin. Otherwise: a mesa, higher than its surroundings. */
      if (wall === undefined) classOf[key] = 'islet';
      else if (wall < -0.1) classOf[key] = 'basin';
      else classOf[key] = 'mesa';
      kindCounts[classOf[key]] = (kindCounts[classOf[key]] || 0) + 1;
      if (cr < shore * 0.9 || classOf[key] === 'mesa') {
        pockets.push({ n: c2.n, x: Math.round(cx2), z: Math.round(cz2), r: Math.round(cr),
          kind: classOf[key], wall: wall === undefined ? null : +wall.toFixed(2) });
      }
    }
    pockets.sort(function (a, b) { return b.n - a.n; });
    /* content reachability, split by what the pocket IS: an islet in water is
       reached by air and is fine; a basin is a place a body can drop into and
       never climb out of, so nothing the world placed may live in one. */
    var unreachable = [], uTowns = 0, uBuildings = 0, uTrees = 0, uLoot = 0;
    var uLootBasin = 0, uLootIslet = 0, uTreesBasin = 0, uTreesIslet = 0;
    function reach(x, z) {
      var id5 = nodeIdAt(x, z);
      return id5 >= 0 && find(id5) === mainRoot;
    }
    function classAt(x, z) {
      var id6 = nodeIdAt(x, z);
      return id6 < 0 ? 'water' : (classOf[find(id6)] || 'ledge');
    }
    for (var ti2 = 0; ti2 < World.towns.length; ti2++) {
      var tw = World.towns[ti2];
      if (!reach(tw.x, tw.z)) {
        uTowns++;
        unreachable.push({ kind: 'town', n: tw.name, x: Math.round(tw.x), z: Math.round(tw.z), pocket: classAt(tw.x, tw.z) });
      }
      for (var bi2 = 0; bi2 < tw.buildings.length; bi2++) {
        var bb = tw.buildings[bi2];
        if (!reach(bb.x, bb.z)) {
          uBuildings++;
          if (unreachable.length < 12) {
            unreachable.push({ kind: 'building', town: tw.name, x: Math.round(bb.x), z: Math.round(bb.z), pocket: classAt(bb.x, bb.z) });
          }
        }
      }
    }
    var treeStride = Math.max(1, Math.floor(World.treeSpots.length / 250));
    for (var ts = 0; ts < World.treeSpots.length; ts += treeStride) {
      var sp = World.treeSpots[ts];
      if (!reach(sp.x, sp.z)) {
        uTrees++;
        var cT = classAt(sp.x, sp.z);
        if (cT === 'basin') uTreesBasin++;
        else if (cT === 'islet' || cT === 'water') uTreesIslet++;
        if (unreachable.length < 12) unreachable.push({ kind: 'tree', x: Math.round(sp.x), z: Math.round(sp.z), pocket: cT });
      }
    }
    var lootStride = Math.max(1, Math.floor(World.lootPoints.length / 250));
    for (var ls = 0; ls < World.lootPoints.length; ls += lootStride) {
      var lp = World.lootPoints[ls];
      if (!reach(lp.x, lp.z)) {
        uLoot++;
        var cL = classAt(lp.x, lp.z);
        if (cL === 'basin') uLootBasin++;
        else if (cL === 'islet' || cL === 'water') uLootIslet++;
        if (unreachable.length < 12) unreachable.push({ kind: 'loot', x: Math.round(lp.x), z: Math.round(lp.z), pocket: cL });
      }
    }
    out.walk = { nodes: total, comps: comps, stepEdges: stepEdges, climbEdges: climbEdges,
      pockets: pockets.slice(0, 8), pocketN: pockets.length, kindCounts: kindCounts,
      unreachable: unreachable, uTowns: uTowns, uBuildings: uBuildings, uTrees: uTrees, uLoot: uLoot,
      uLootBasin: uLootBasin, uLootIslet: uLootIslet, uTreesBasin: uTreesBasin, uTreesIslet: uTreesIslet,
      bridgeLinks: bridgeLinks, bridgeWadeOnly: bridgeWadeOnly, bridgeDeadEnd: bridgeDeadEnd,
      bridgeNoBank: bridgeNoBank, bridgeNoBankAt: bridgeNoBankAt };
    /* ================= 5. foundations: buildings sit IN the ground ================= */
    var floats = [], floatN = 0, worstFloat = null, buries = [], buryN = 0, worstBury = null;
    var bCount = 0;
    for (var ti3 = 0; ti3 < World.towns.length; ti3++) {
      var town3 = World.towns[ti3];
      for (var bi3 = 0; bi3 < town3.buildings.length; bi3++) {
        var b3 = town3.buildings[bi3];
        bCount++;
        var hx = b3.w / 2 - 0.05, hz = b3.d / 2 - 0.05;
        var pts = [[b3.x - hx, b3.z - hz], [b3.x + hx, b3.z - hz],
                   [b3.x + hx, b3.z + hz], [b3.x - hx, b3.z + hz],
                   [b3.x - hx, b3.z], [b3.x + hx, b3.z],
                   [b3.x, b3.z - hz], [b3.x, b3.z + hz]];
        var gmin = 1e9, gmax = -1e9, atMin = null;
        for (var pi = 0; pi < pts.length; pi++) {
          var g = World.heightAt(pts[pi][0], pts[pi][1]);
          if (g < gmin) { gmin = g; atMin = pts[pi]; }
          if (g > gmax) gmax = g;
        }
        /* the foundation slab is 0.5 m deep: bottom at y - 0.40, top at y + 0.10 */
        var gap = b3.y - gmin;
        if (gap > 0.45) {
          floatN++;
          if (floats.length < 8) floats.push({ town: town3.name, x: Math.round(b3.x), z: Math.round(b3.z),
            gap: +gap.toFixed(2), low: [Math.round(atMin[0]), Math.round(atMin[1])] });
          if (!worstFloat || gap > worstFloat.gap) {
            worstFloat = { town: town3.name, gap: +gap.toFixed(2), x: Math.round(b3.x), z: Math.round(b3.z) };
          }
        }
        var bury = gmax - b3.y;
        if (bury > 1.6) {
          buryN++;
          if (buries.length < 8) buries.push({ town: town3.name, x: Math.round(b3.x), z: Math.round(b3.z), bury: +bury.toFixed(2) });
          if (!worstBury || bury > worstBury.bury) {
            worstBury = { town: town3.name, bury: +bury.toFixed(2), x: Math.round(b3.x), z: Math.round(b3.z) };
          }
        }
      }
    }
    out.foundations = { buildings: bCount, floatN: floatN, floats: floats, worstFloat: worstFloat,
      buryN: buryN, buries: buries, worstBury: worstBury };

    /* ================= 6. bridges: a body can walk the whole crossing both ways =================
       Only PLATFORMS obey a step-up window: the terrain is a hard surface the body
       follows up whatever its slope, so a hill at the end of a bridge is not a
       defect - but a deck too high to step onto IS one. The window the walker
       really has is 0.62 m inside World.groundAt plus the 0.65 m Player.update
       passes on top of the feet, i.e. 1.27 m above the soles. March the deck's
       own polyline in 0.8 m steps, both ways, and fail where a plank needs more
       than that. */
    var STEP_UP = 1.27;
    var bridgeBad = [], bridgeBadN = 0, bridgeOk = 0;
    for (var br2 = 0; br2 < World.bridges.length; br2++) {
      var brg = World.bridges[br2];
      var pts2 = brg.pts, segL = [], cum2 = [0], tot2 = 0;
      for (var k2 = 0; k2 + 1 < pts2.length; k2++) {
        var l2 = Math.hypot(pts2[k2 + 1][0] - pts2[k2][0], pts2[k2 + 1][1] - pts2[k2][1]) || 1e-3;
        segL.push(l2);
        tot2 += l2;
        cum2.push(tot2);
      }
      for (var dir2 = 0; dir2 < 2; dir2++) {
        var steps2 = Math.max(2, Math.ceil(tot2 / 0.8));
        var feet2 = null, fail2 = null;
        for (var s2 = 0; s2 <= steps2; s2++) {
          var d2 = dir2 === 0 ? s2 * tot2 / steps2 : tot2 - s2 * tot2 / steps2;
          var kk = 0;
          while (kk < segL.length - 1 && cum2[kk + 1] < d2) kk++;
          var tt = clamp((d2 - cum2[kk]) / segL[kk], 0, 1);
          var px4 = pts2[kk][0] + (pts2[kk + 1][0] - pts2[kk][0]) * tt;
          var pz4 = pts2[kk][1] + (pts2[kk + 1][1] - pts2[kk][1]) * tt;
          var terr2 = World.heightAt(px4, pz4);
          if (feet2 === null) {
            feet2 = Math.max(terr2, World.groundAt(px4, pz4, terr2 + 0.62));
            continue;
          }
          var plat2 = World.groundAt(px4, pz4, feet2 + 0.65);
          if (plat2 > terr2 + 0.01 && plat2 > feet2 + STEP_UP) {
            fail2 = { at: [Math.round(px4), Math.round(pz4)], rise: +(plat2 - feet2).toFixed(2), d: Math.round(d2) };
            break;
          }
          feet2 = Math.max(plat2, terr2);
        }
        if (fail2) {
          bridgeBadN++;
          if (bridgeBad.length < 8) {
            bridgeBad.push({ y: +brg.y.toFixed(2), dir: dir2, at: fail2.at, rise: fail2.rise, d: fail2.d });
          }
        } else bridgeOk++;
      }
    }
    out.bridges = { total: World.bridges.length, walks: World.bridges.length * 2,
      walksClean: bridgeOk, walksBad: bridgeBadN, worst: bridgeBad };

    /* ================= 7. props stand in the ground they were planted in ================= */
    var treeDev = 0, treeAt = null;
    for (var tr2 = 0; tr2 < World.treeSpots.length; tr2++) {
      var tp = World.treeSpots[tr2];
      var dv2 = Math.abs(World.heightAt(tp.x, tp.z) - tp.y);
      if (dv2 > treeDev) { treeDev = dv2; treeAt = { x: Math.round(tp.x), z: Math.round(tp.z), y: +tp.y.toFixed(2) }; }
    }
    out.trees = { count: World.treeSpots.length, worstDev: +treeDev.toFixed(3), at: treeAt };

    /* ================= 8. the invisible wall and the kill-zone floor ================= */
    var ringDry = [], ringMin = 1e9, ringMax = -1e9;
    for (var a3 = 0; a3 < 240; a3++) {
      var aa = a3 / 240 * Math.PI * 2;
      var rx = Math.cos(aa) * World.boundary, rz = Math.sin(aa) * World.boundary;
      var rh = World.heightAt(rx, rz);
      if (rh < ringMin) ringMin = rh;
      if (rh > ringMax) ringMax = rh;
      if (rh > SEA + 0.3 && ringDry.length < 6) ringDry.push({ x: Math.round(rx), z: Math.round(rz), h: +rh.toFixed(2) });
    }
    /* land outside the wall, and the furthest dry point from the middle */
    var landBeyond = 0, beyondAt = null, maxDryR = 0;
    for (var bgi = 0; bgi < 160; bgi++) {
      for (var bgj = 0; bgj < 160; bgj++) {
        var bx = -World.hHalf + (bgi + 0.5) * (World.mapSize / 160);
        var bz = -World.hHalf + (bgj + 0.5) * (World.mapSize / 160);
        var bh = World.heightAt(bx, bz);
        if (bh <= SEA + 0.6) continue;
        var brr = Math.hypot(bx, bz);
        if (brr > maxDryR) maxDryR = brr;
        if (brr > World.boundary) {
          landBeyond++;
          if (!beyondAt) beyondAt = { x: Math.round(bx), z: Math.round(bz), h: +bh.toFixed(2), r: Math.round(brr) };
        }
      }
    }
    /* the fail-safe floor: on DRY LAND it is the terrain itself (anywhere it rose
       above that would be an invisible floor to bump into), and everywhere it is
       at most the sea surface - the water plane is what holds a swimmer up */
    var worstFloor = 0, floorAt = null, worstWaterFloor = -1e9;
    for (var fi2 = 0; fi2 < 200; fi2++) {
      for (var fj2 = 0; fj2 < 200; fj2++) {
        var fx2 = -World.hHalf + (fi2 + 0.5) * (World.mapSize / 200);
        var fz2 = -World.hHalf + (fj2 + 0.5) * (World.mapSize / 200);
        var fh2 = World.heightAt(fx2, fz2);
        var fl2 = World.floorFor(fx2, fz2);
        if (fh2 > SEA + 0.6) {
          var fd2 = fl2 - fh2;
          if (fd2 > worstFloor) { worstFloor = fd2; floorAt = { x: Math.round(fx2), z: Math.round(fz2) }; }
        } else if (fh2 < SEA - 1.4) {
          if (fl2 > worstWaterFloor) worstWaterFloor = fl2;   // the sea plane holding a swimmer up
        }
      }
    }
    /* drop a body 40 m under the world at random dry points: it must come back */
    var rescueFail = 0, rescueMiss = [], rescuePush = 0;
    for (var rf = 0; rf < 200; rf++) {
      var ang2 = Math.random() * Math.PI * 2, rad2 = Math.random() * World.mapRadius * 0.9;
      var qx = Math.cos(ang2) * rad2, qz = Math.sin(ang2) * rad2;
      var qh = World.heightAt(qx, qz);
      if (qh < 1) continue;
      var body = { x: qx, z: qz, y: qh - 40 };
      var lifted = World.rescueFromVoid(body, true);
      if (!lifted) {
        rescueFail++;
        if (rescueMiss.length < 6) rescueMiss.push({ x: Math.round(qx), z: Math.round(qz), y: +body.y.toFixed(1) });
        continue;
      }
      if (body.y < World.floorFor(qx, qz) - 0.01) rescuePush++;
    }
    out.void = { ringMin: +ringMin.toFixed(2), ringMax: +ringMax.toFixed(2), ringDry: ringDry,
      landBeyond: landBeyond, beyondAt: beyondAt, maxDryR: Math.round(maxDryR),
      boundary: World.boundary, worstFloor: +worstFloor.toFixed(3), floorAt: floorAt,
      worstWaterFloor: +worstWaterFloor.toFixed(2),
      rescueFail: rescueFail, rescueMiss: rescueMiss, rescuePush: rescuePush };

    /* ================= 9. the offshore islets the art draws ================= */
    var missingIslets = [], isletMin = 1e9;
    for (var i2 = 0; i2 < ISLE_ISLETS.length; i2++) {
      var isl = ISLE_ISLETS[i2];
      var ix = isleWorldX(isl.x), iz = isleWorldZ(isl.z);
      var ih = World.heightAt(ix, iz);
      if (ih < isletMin) isletMin = ih;
      if (ih < SEA + 0.5) {
        missingIslets.push({ px: Math.round(isl.x), py: Math.round(isl.z),
          x: Math.round(ix), z: Math.round(iz), h: +ih.toFixed(2) });
      }
    }
    out.islets = { count: ISLE_ISLETS.length, minH: +isletMin.toFixed(2), missing: missingIslets };

    App.state = 'MENU';
    return out;
  })()`);

  /* ---------------- report ---------------- */
  console.log('  heightmap: ' + JSON.stringify(res.height));
  console.log('  mesh vs collision: quads ' + res.mesh.quads + ', wrong split ' + res.mesh.wrongSplit +
    ', worst vertex off-lattice ' + res.mesh.worstVertex.toFixed(5) +
    ', worst surface gap ' + res.mesh.maxDev.toFixed(4) + ' m at ' + JSON.stringify(res.mesh.devAt));
  console.log('  water table: ' + res.water.waterCells + ' all-water cells, ' +
    res.water.dryCells + ' all-dry inland cells, ' + res.water.dryLakeN +
    ' dry lake cells, ' + res.water.floodLandN + ' flooded land cells');
  if (res.water.dryLakes.length) console.log('    dry lake samples: ' + JSON.stringify(res.water.dryLakes));
  if (res.water.floodLand.length) console.log('    flooded land samples: ' + JSON.stringify(res.water.floodLand));
  console.log('  walk graph: ' + res.walk.nodes + ' dry nodes in ' + res.walk.comps + ' component(s), ' +
    res.walk.stepEdges + ' step edges + ' + res.walk.climbEdges + ' climb edges, bridges linked ' +
    res.walk.bridgeLinks + ', wade-only ends ' + res.walk.bridgeWadeOnly + ', no bank ' + res.walk.bridgeNoBank +
    ', pockets ' + JSON.stringify(res.walk.kindCounts) + ', listed ' + res.walk.pocketN);
  if (res.walk.pockets.length) console.log('    pockets: ' + JSON.stringify(res.walk.pockets));
  if (res.walk.bridgeNoBankAt.length) console.log('    decks with no bank: ' + JSON.stringify(res.walk.bridgeNoBankAt));
  if (res.walk.unreachable.length) console.log('    unreachable: ' + JSON.stringify(res.walk.unreachable));
  console.log('  foundations: ' + res.foundations.buildings + ' buildings, ' +
    res.foundations.floatN + ' floating, ' + res.foundations.buryN + ' buried past the door' +
    (res.foundations.worstFloat ? ', worst float ' + JSON.stringify(res.foundations.worstFloat) : ''));
  console.log('  bridges: ' + res.bridges.walksClean + '/' + res.bridges.walks + ' deck crossings walk clean' +
    (res.bridges.worst.length ? ', worst ' + JSON.stringify(res.bridges.worst.slice(0, 2)) : ''));
  console.log('  trees: ' + res.trees.count + ' planted, worst height error ' +
    res.trees.worstDev.toFixed(3) + ' m');
  console.log('  wall/void: wall ring y ' + res.void.ringMin + '..' + res.void.ringMax +
    ', dry ring points ' + res.void.ringDry.length + ', land outside ' + res.void.landBeyond +
    ', furthest dry point r=' + res.void.maxDryR + ' (wall r=' + res.void.boundary + ')' +
    ', worst floor-above-ground ' + res.void.worstFloor.toFixed(3) + ' m, deep-water floor lift ' + res.void.worstWaterFloor);
  console.log('  fail-safe: ' + res.void.rescueFail + ' failed lift(s), ' +
    res.void.rescuePush + ' landed under the floor' +
    (res.void.rescueMiss.length ? ' ' + JSON.stringify(res.void.rescueMiss) : ''));
  console.log('  islets: ' + res.islets.count + ' drawn, lowest centre y ' + res.islets.minH +
    ', missing ' + res.islets.missing.length +
    (res.islets.missing.length ? ' ' + JSON.stringify(res.islets.missing) : ''));

  /* ---------------- checks ---------------- */
  check('the heightmap is finite everywhere (no void vertices)',
    res.height.nan === 0,
    res.height.verts + ' vertices, y ' + res.height.min + '..' + res.height.max + ', ' + res.height.nan + ' bad');

  check('the drawn mesh uses the collision lattice and quad split',
    res.mesh.wrongSplit === 0 && res.mesh.worstVertex < 0.01 &&
    res.mesh.verts === res.mesh.expectedVerts && res.mesh.index === res.mesh.expectedIndex,
    res.mesh.wrongSplit + ' wrong split(s), worst vertex off-lattice ' + res.mesh.worstVertex.toFixed(5) +
    ', ' + res.mesh.verts + '/' + res.mesh.expectedVerts + ' verts');

  check('the drawn surface and the surface you stand on are the same surface',
    res.mesh.maxDev < 0.05,
    'worst gap ' + res.mesh.maxDev.toFixed(4) + ' m ' + JSON.stringify(res.mesh.devAt));

  check('no cell the picture draws as water is dry land',
    res.water.dryLakeN === 0,
    res.water.dryLakeN + ' dry lake cell(s)' +
    (res.water.dryLakes.length ? ' ' + JSON.stringify(res.water.dryLakes.slice(0, 3)) : ''));

  check('no landlocked water sits on dry land',
    res.water.floodLandN === 0,
    res.water.floodLandN + ' flooded land cell(s)' +
    (res.water.floodLand.length ? ' ' + JSON.stringify(res.water.floodLand.slice(0, 3)) : ''));

  check('every building foundation meets the ground under it',
    res.foundations.floatN === 0,
    res.foundations.floatN + '/' + res.foundations.buildings + ' floating' +
    (res.foundations.worstFloat ? ' ' + JSON.stringify(res.foundations.worstFloat) : ''));

  check('no building is buried up past its doorway',
    res.foundations.buryN === 0,
    res.foundations.buryN + ' buried' + (res.foundations.worstBury ? ' ' + JSON.stringify(res.foundations.worstBury) : ''));

  check('every bridge crossing walks clean, both directions',
    res.bridges.walksBad === 0,
    res.bridges.walksBad + '/' + res.bridges.walks + ' crossing(s) hit an unreachable plank' +
    (res.bridges.worst.length ? ' ' + JSON.stringify(res.bridges.worst.slice(0, 2)) : ''));

  check('every tree stands in the ground it was planted in',
    res.trees.worstDev < 0.01,
    'worst error ' + res.trees.worstDev.toFixed(4) + ' m at ' + JSON.stringify(res.trees.at));

  check('every town and building is reachable on foot over the bridge network',
    res.walk.uTowns + res.walk.uBuildings === 0,
    res.walk.uTowns + ' towns, ' + res.walk.uBuildings + ' buildings out of reach' +
    (res.walk.unreachable.length ? ' ' + JSON.stringify(res.walk.unreachable.slice(0, 4)) : ''));

  check('every deck end reaches land, a wadeable shelf, or its road terminus',
    res.walk.bridgeNoBank === 0,
    res.walk.bridgeNoBank + ' deck end(s) over deep water, ' + res.walk.bridgeWadeOnly +
    ' wade-only, ' + res.walk.bridgeDeadEnd + ' dead-end over water' +
    (res.walk.bridgeNoBankAt.length ? ' ' + JSON.stringify(res.walk.bridgeNoBankAt.slice(0, 3)) : ''));

  check('no tree or loot point is marooned in a basin (a place you cannot climb out of)',
    res.walk.uLootBasin === 0 && res.walk.uTreesBasin === 0,
    res.walk.uTreesBasin + ' tree(s) and ' + res.walk.uLootBasin + ' loot point(s) in basins; ' +
    res.walk.uTreesIslet + ' tree(s) / ' + res.walk.uLootIslet + ' loot on air-only islets (by design); ' +
    'land kinds ' + JSON.stringify(res.walk.kindCounts));

  check('the invisible wall stands in open water',
    res.void.ringDry.length === 0 && res.void.ringMax <= 0.3,
    'ring y ' + res.void.ringMin + '..' + res.void.ringMax + ', ' + res.void.ringDry.length + ' dry point(s)');

  check('no land lies outside the wall',
    res.void.landBeyond === 0,
    'land max r=' + res.void.maxDryR + ' vs wall r=' + res.void.boundary +
    (res.void.beyondAt ? ' ' + JSON.stringify(res.void.beyondAt) : ''));

  check('the terrain mesh covers the whole playable world',
    res.height.world / 2 >= res.void.boundary + 10,
    'mesh half-span ' + res.height.world / 2 + ' vs wall ' + res.void.boundary);

  check('the fail-safe floor follows the ground on land and the sea in water',
    res.void.worstFloor <= 0.05 && res.void.worstWaterFloor <= 0.05,
    'land floor-above-ground ' + res.void.worstFloor.toFixed(3) + ' m, highest floor over deep water ' +
    res.void.worstWaterFloor + ' m at ' + JSON.stringify(res.void.floorAt));

  check('a body dropped 40 m under the world is lifted back to the surface',
    res.void.rescueFail === 0 && res.void.rescuePush === 0,
    res.void.rescueFail + ' failed lift(s), ' + res.void.rescuePush + ' left under the floor' +
    (res.void.rescueMiss.length ? ' ' + JSON.stringify(res.void.rescueMiss) : ''));

  check('the offshore islets the art draws are really there',
    res.islets.missing.length === 0,
    res.islets.count + ' islets, lowest centre y ' + res.islets.minH +
    (res.islets.missing.length ? ' ' + JSON.stringify(res.islets.missing.slice(0, 4)) : ''));

  return res;
};
