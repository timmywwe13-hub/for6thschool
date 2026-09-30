// Focused probe: the ground under the things the map places.
//
// mapaudit flags foundations, pockets and bridge banks by counting; this probe
// explains them. It prints the nine ground samples under the worst building
// footprints (with the pad, the carve and the islet bump beneath them), how high
// the wall around each inland pocket is and what the world put inside it, where
// the first dry ground beyond each bridge end sits and which landmass owns it,
// and what the water cut did to the offshore islets.
//
//   node cdp-test.js _groundprobe
module.exports = async function groundprobe(ctx) {
  const { evaluate } = ctx;

  const res = await evaluate(`(function () {
    var out = {};
    var SEA = CONFIG.SEA_LEVEL;
    World.build(QUALITY_PRESETS.high, 20260926, 'isle');
    App.state = 'PLAYING';

    /* ---------- the worst building footprints ---------- */
    var rows = [];
    for (var ti = 0; ti < World.towns.length; ti++) {
      var town = World.towns[ti];
      for (var bi = 0; bi < town.buildings.length; bi++) {
        var b = town.buildings[bi];
        var hx = b.w / 2, hz = b.d / 2;
        var gmin = 1e9, gmax = -1e9, gmed = [], atMin = null, atMax = null;
        for (var sx = -1; sx <= 1; sx += 2) {
          for (var sz = -1; sz <= 1; sz += 2) {
            var g = World.heightAt(b.x + sx * hx, b.z + sz * hz);
            gmed.push(g);
            if (g < gmin) { gmin = g; atMin = [Math.round(b.x + sx * hx), Math.round(b.z + sz * hz)]; }
            if (g > gmax) { gmax = g; atMax = [Math.round(b.x + sx * hx), Math.round(b.z + sz * hz)]; }
          }
        }
        gmed.push(World.heightAt(b.x, b.z));
        gmed.sort(function (x, y) { return x - y; });
        rows.push({ town: town.name, x: Math.round(b.x), z: Math.round(b.z), w: +b.w.toFixed(1), d: +b.d.toFixed(1),
          y: +b.y.toFixed(2), gmin: +gmin.toFixed(2), gmax: +gmax.toFixed(2), gmed: +gmed[4].toFixed(2),
          gap: +(b.y - gmin).toFixed(2), bury: +(gmax - b.y).toFixed(2),
          atMin: atMin, atMax: atMax, dTown: Math.round(Math.hypot(b.x - town.x, b.z - town.z)) });
      }
    }
    rows.sort(function (a, b) { return Math.max(b.gap, b.bury) - Math.max(a.gap, a.bury); });
    out.worst = rows.slice(0, 6);
    out.detail = rows.slice(0, 3).map(function (r2) {
      var pad = null, best = -1e9;
      for (var f = 0; f < FLATS.length; f++) {
        var d = Math.hypot(r2.x - FLATS[f].x, r2.z - FLATS[f].z) - FLATS[f].r;
        if (d > best) { best = d; pad = { x: Math.round(FLATS[f].x), z: Math.round(FLATS[f].z), r: FLATS[f].r, y: +FLATS[f].y.toFixed(2), inside: +(d).toFixed(1) }; }
      }
      var base = isleBaseHeight(r2.x, r2.z);
      return { at: [r2.x, r2.z], town: r2.town, base: +base.toFixed(2),
        cut: +isleWaterCut(base, r2.x, r2.z).toFixed(2), carve: +isleCarve(r2.x, r2.z).toFixed(2),
        islet: isleIsletH(r2.x, r2.z), pad: pad, grid: +World.heightAt(r2.x, r2.z).toFixed(2) };
    });

    /* ---------- the walk graph, exactly as mapaudit builds it ---------- */
    var G = 500, gstep = World.mapSize / G;
    var idArr = new Int32Array(G * G);
    var nx = new Float32Array(G * G), nz = new Float32Array(G * G), nh = new Float32Array(G * G);
    var total = 0;
    for (var gi = 0; gi < G; gi++) {
      for (var gj = 0; gj < G; gj++) {
        var x0 = -World.hHalf + (gi + 0.5) * gstep, z0 = -World.hHalf + (gj + 0.5) * gstep;
        var h0 = World.heightAt(x0, z0);
        idArr[gi * G + gj] = -1;
        if (h0 > SEA + 0.55) { idArr[gi * G + gj] = total; nx[total] = x0; nz[total] = z0; nh[total] = h0; total++; }
      }
    }
    var par = new Int32Array(total);
    for (var t = 0; t < total; t++) par[t] = t;
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    function uni(a, b) { a = find(a); b = find(b); if (a !== b) par[b] = a; }
    for (var gi2 = 0; gi2 < G; gi2++) {
      for (var gj2 = 0; gj2 < G; gj2++) {
        var me = idArr[gi2 * G + gj2];
        if (me < 0) continue;
        if (gi2 + 1 < G) { var o1 = idArr[(gi2 + 1) * G + gj2]; if (o1 >= 0 && Math.abs(nh[me] - nh[o1]) <= 2.05) uni(me, o1); }
        if (gj2 + 1 < G) { var o2 = idArr[gi2 * G + gj2 + 1]; if (o2 >= 0 && Math.abs(nh[me] - nh[o2]) <= 2.05) uni(me, o2); }
      }
    }
    var originId = -1, bestR = 1e9;
    for (var t1 = 0; t1 < total; t1++) { var rr = Math.hypot(nx[t1], nz[t1]); if (rr < bestR) { bestR = rr; originId = t1; } }
    var mainRoot = find(originId);
    function nodeAt(x, z) {
      var gx = Math.floor((x + World.hHalf) / gstep), gz = Math.floor((z + World.hHalf) / gstep);
      if (gx < 0 || gz < 0 || gx >= G || gz >= G) return -1;
      return idArr[gx * G + gz];
    }

    /* ---------- pockets: how high is the wall, and what is inside ---------- */
    var sizes = {};
    for (var t2 = 0; t2 < total; t2++) {
      var r3 = find(t2);
      if (!sizes[r3]) sizes[r3] = { n: 0, sx: 0, sz: 0 };
      sizes[r3].n++; sizes[r3].sx += nx[t2]; sizes[r3].sz += nz[t2];
    }
    /* the tightest wall around each component: the smallest step UP from it to a
       neighbour that is not in it (a climb blocks you; a drop is free) */
    var wallMin = {};
    for (var gi3 = 0; gi3 < G; gi3++) {
      for (var gj3 = 0; gj3 < G; gj3++) {
        var a3 = idArr[gi3 * G + gj3];
        if (a3 < 0) continue;
        var ra = find(a3);
        var nb = [];
        if (gi3 + 1 < G) nb.push(idArr[(gi3 + 1) * G + gj3]);
        if (gj3 + 1 < G) nb.push(idArr[gi3 * G + gj3 + 1]);
        if (gi3 > 0) nb.push(idArr[(gi3 - 1) * G + gj3]);
        if (gj3 > 0) nb.push(idArr[gi3 * G + gj3 - 1]);
        for (var p = 0; p < nb.length; p++) {
          var oi = nb[p];
          if (oi < 0) continue;
          var ro = find(oi);
          if (ro === ra) continue;
          var up = nh[a3] - nh[oi];
          if (wallMin[ra] === undefined || up < wallMin[ra]) wallMin[ra] = up;
          if (wallMin[ro] === undefined || up < wallMin[ro]) wallMin[ro] = up;
        }
      }
    }
    var pockets = [];
    for (var key in sizes) {
      var c = sizes[key];
      if (c.n < 25 || String(key) === String(mainRoot)) continue;
      var cx = c.sx / c.n, cz = c.sz / c.n;
      var inTown = null, bCount = 0, lootN = 0;
      for (var ti2 = 0; ti2 < World.towns.length; ti2++) {
        var tw = World.towns[ti2];
        var idTown = nodeAt(tw.x, tw.z);
        if (idTown >= 0 && find(idTown) === find(key)) inTown = tw.name;
        for (var b2 = 0; b2 < tw.buildings.length; b2++) {
          var idb = nodeAt(tw.buildings[b2].x, tw.buildings[b2].z);
          if (idb >= 0 && find(idb) === find(key)) bCount++;
        }
      }
      var stride = Math.max(1, Math.floor(World.lootPoints.length / 400));
      for (var li = 0; li < World.lootPoints.length; li += stride) {
        var idl = nodeAt(World.lootPoints[li].x, World.lootPoints[li].z);
        if (idl >= 0 && find(idl) === find(key)) lootN++;
      }
      pockets.push({ n: c.n, x: Math.round(cx), z: Math.round(cz), town: inTown,
        buildings: bCount, loot: lootN,
        wall: wallMin[key] === undefined ? null : +wallMin[key].toFixed(2) });
    }
    pockets.sort(function (a, b) { return b.n - a.n; });
    out.pockets = pockets.slice(0, 12);
    out.pocketCount = pockets.length;

    /* ---------- bridge banks: where the dry ground is, and whose land it is ---------- */
    function firstDryNode(px, pz, dx, dz) {
      for (var d4 = 2; d4 <= 18; d4 += 2) {
        var x4 = px + dx * d4, z4 = pz + dz * d4;
        var id4 = nodeAt(x4, z4);
        if (id4 >= 0) return { d: d4, root: find(id4), h: +nh[id4].toFixed(2), at: [Math.round(x4), Math.round(z4)] };
      }
      return null;
    }
    out.bridges = World.bridges.map(function (bg) {
      function dir(p, q) { var dx = p[0] - q[0], dz = p[1] - q[1]; var L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; }
      var p0 = bg.pts[0], p1 = bg.pts[bg.pts.length - 1];
      var dA = dir(p0, bg.pts[1]), dB = dir(p1, bg.pts[bg.pts.length - 2]);
      var A = firstDryNode(p0[0], p0[1], dA[0], dA[1]);
      var B = firstDryNode(p1[0], p1[1], dB[0], dB[1]);
      return { y: +bg.y.toFixed(2), A: A, B: B,
        sameRoot: !!(A && B && A.root === B.root),
        mainA: !!(A && A.root === mainRoot), mainB: !!(B && B.root === mainRoot) };
    }).filter(function (r4) { return !r4.sameRoot; });

    /* ---------- islets: what the water cut did to them ---------- */
    out.islets = ISLE_ISLETS.map(function (s) {
      var ix = isleWorldX(s.x), iz = isleWorldZ(s.z);
      var base = isleBaseHeight(ix, iz);
      var bump = isleIsletH(ix, iz);
      return { px: s.x, py: s.z, x: Math.round(ix), z: Math.round(iz),
        bump: +bump.toFixed(2), base: +base.toFixed(2),
        carve: +isleCarve(ix, iz).toFixed(2),
        cut: +isleWaterCut(base, ix, iz).toFixed(2),
        grid: +World.heightAt(ix, iz).toFixed(2),
        after: +Math.max(World.heightAt(ix, iz), bump).toFixed(2) };
    });

    App.state = 'MENU';
    return out;
  })()`);

  console.log('  worst footprints: ' + JSON.stringify(res.worst, null, 1));
  console.log('  terrain under the worst three: ' + JSON.stringify(res.detail, null, 1));
  console.log('  pockets (' + res.pocketCount + '): ' + JSON.stringify(res.pockets, null, 1));
  console.log('  bridges whose banks are in different components: ' + JSON.stringify(res.bridges, null, 1));
  console.log('  islets: ' + JSON.stringify(res.islets, null, 1));
  return res;
};

