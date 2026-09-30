// Focused probe: the two spots mapaudit still flags, in full detail - the
// building at ICEBOUND KEEP whose foundation reads 0.78 m off the ground, and
// the bridge at (330,-406) whose ends fail the walk march. Prints the ground
// under every probe point, the lots that cover the building, the deck heights,
// and a sample-by-sample trace of both walk directions with the platforms the
// query can see at each step.
//
//   node cdp-test.js _fxprobe
module.exports = async function fxprobe(ctx) {
  const { evaluate } = ctx;

  const res = await evaluate(`(function () {
    var out = {};
    var SEA = CONFIG.SEA_LEVEL;
    World.build(QUALITY_PRESETS.high, 20260926, 'isle');
    App.state = 'PLAYING';

    /* ---------- the building ---------- */
    var hit = null;
    for (var ti = 0; ti < World.towns.length; ti++) {
      var tw = World.towns[ti];
      for (var bi = 0; bi < tw.buildings.length; bi++) {
        var b = tw.buildings[bi];
        if (Math.hypot(b.x - 308, b.z + 426) < 14) hit = { b: b, town: tw };
      }
    }
    if (hit) {
      var b2 = hit.b, hx = b2.w / 2 - 0.05, hz = b2.d / 2 - 0.05;
      var probes = [[b2.x - hx, b2.z - hz], [b2.x + hx, b2.z - hz], [b2.x + hx, b2.z + hz], [b2.x - hx, b2.z + hz],
                    [b2.x - hx, b2.z], [b2.x + hx, b2.z], [b2.x, b2.z - hz], [b2.x, b2.z + hz]];
      out.building = { at: [Math.round(b2.x), Math.round(b2.z)], y: +b2.y.toFixed(3),
        w: +b2.w.toFixed(1), d: +b2.d.toFixed(1), town: hit.town.name,
        townY: +World.heightAt(hit.town.x, hit.town.z).toFixed(3),
        probes: probes.map(function (p) {
          return { at: [Math.round(p[0]), Math.round(p[1])], h: +World.heightAt(p[0], p[1]).toFixed(3) };
        }),
        lots: LOTS.filter(function (l) {
          return Math.hypot(l.x - b2.x, l.z - b2.z) < 60;
        }).map(function (l) {
          var d = Math.hypot(l.x - b2.x, l.z - b2.z);
          return { x: Math.round(l.x), z: Math.round(l.z), r: +l.r.toFixed(1), y: +l.y.toFixed(2),
                   d: +d.toFixed(1), dOverR: +(d / l.r).toFixed(3) };
        })
      };
    }

    /* ---------- the bridge crossing that still rises ---------- */
    var brg = null, bestD = 1e9;
    for (var i = 0; i < World.bridges.length; i++) {
      var g = World.bridges[i];
      for (var k = 0; k < g.pts.length; k++) {
        var d0 = Math.hypot(g.pts[k][0] + 546, g.pts[k][1] - 550);
        if (d0 < bestD) { bestD = d0; brg = g; }
      }
    }
    if (brg) {
      var info = { deckY: +brg.y.toFixed(2), pts: brg.pts.length, nearest: +bestD.toFixed(1),
        a: [Math.round(brg.pts[0][0]), Math.round(brg.pts[0][1])],
        b: [Math.round(brg.pts[brg.pts.length - 1][0]), Math.round(brg.pts[brg.pts.length - 1][1])],
        bankA: +World.heightAt(brg.pts[0][0], brg.pts[0][1]).toFixed(2),
        bankB: +World.heightAt(brg.pts[brg.pts.length - 1][0], brg.pts[brg.pts.length - 1][1]).toFixed(2) };
      var pts3 = brg.pts, segL3 = [], cum3 = [0], tot3 = 0;
      for (var k3 = 0; k3 + 1 < pts3.length; k3++) {
        var l3 = Math.hypot(pts3[k3 + 1][0] - pts3[k3][0], pts3[k3 + 1][1] - pts3[k3][1]) || 1e-3;
        segL3.push(l3); tot3 += l3; cum3.push(tot3);
      }
      info.total = +tot3.toFixed(1);
      function march(dir) {
        var steps = Math.max(2, Math.ceil(tot3 / 0.8));
        var feet = null, rows = [];
        for (var s = 0; s <= steps; s++) {
          var d = dir === 0 ? s * tot3 / steps : tot3 - s * tot3 / steps;
          var kk = 0;
          while (kk < segL3.length - 1 && cum3[kk + 1] < d) kk++;
          var tt = Math.max(0, Math.min(1, (d - cum3[kk]) / segL3[kk]));
          var px5 = pts3[kk][0] + (pts3[kk + 1][0] - pts3[kk][0]) * tt;
          var pz5 = pts3[kk][1] + (pts3[kk + 1][1] - pts3[kk][1]) * tt;
          var terr = World.heightAt(px5, pz5);
          var platN = null, platBest = -1e9;
          for (var q = 0; q < World.platforms.length; q++) {
            var p = World.platforms[q];
            if (px5 > p.x - p.hx && px5 < p.x + p.hx && pz5 > p.z - p.hz && pz5 < p.z + p.hz) {
              if (p.y > platBest) { platBest = p.y; platN = +p.y.toFixed(2); }
            }
          }
          var row = { d: Math.round(d), at: [Math.round(px5), Math.round(pz5)],
            terr: +terr.toFixed(2), plat: platN };
          if (feet === null) {
            feet = Math.max(terr, World.groundAt(px5, pz5, terr + 0.62));
            row.feet = +feet.toFixed(2); row.rise = 0;
          } else {
            var plat2 = World.groundAt(px5, pz5, feet + 0.62);
            row.feetBefore = +feet.toFixed(2);
            row.rise = +(plat2 - feet).toFixed(2);
            if (plat2 > terr + 0.01 && plat2 > feet + 0.62) { rows.push(row); info['fail' + dir] = row; break; }
            feet = Math.max(plat2, terr);
            row.feet = +feet.toFixed(2);
          }
          rows.push(row);
        }
        info['dir' + dir + 'count'] = rows.length;
        info['dir' + dir] = rows.filter(function (r) { return r.rise > 0.5; }).slice(0, 6);
      }
      march(0);
      march(1);
      /* the ground marching outward from each end, every 2 m for 44 m */
      function scanEnd(end, prev2) {
        var ddx = end[0] - prev2[0], ddz = end[1] - prev2[1];
        var L2 = Math.hypot(ddx, ddz) || 1;
        ddx /= L2; ddz /= L2;
        var rows = [];
        for (var dd3 = 0; dd3 <= 44; dd3 += 2) {
          rows.push(+World.heightAt(end[0] + ddx * dd3, end[1] + ddz * dd3).toFixed(2));
        }
        return rows;
      }
      info.scanA = scanEnd(pts3[0], pts3[1]);
      info.scanB = scanEnd(pts3[pts3.length - 1], pts3[pts3.length - 2]);
      info.head = pts3.slice(0, 4).map(function (q) { return [Math.round(q[0]), Math.round(q[1]), +World.heightAt(q[0], q[1]).toFixed(2)]; });
      out.bridge = info;
    }

    /* ---------- the building corner that reads low ---------- */
    out.corner = (function () {
      var x = 318, z = -413;
      var base = isleBaseHeight(x, z);
      var cutV = isleWaterCut(base, x, z);
      var n2 = World.hN + 1;
      var gxi = Math.floor((x + World.hHalf) / World.hStep);
      var gzi = Math.floor((z + World.hHalf) / World.hStep);
      var nodes = [];
      for (var i = 0; i <= 1; i++) {
        for (var j = 0; j <= 1; j++) {
          var nx2 = -World.hHalf + (gxi + i) * World.hStep;
          var nz2 = -World.hHalf + (gzi + j) * World.hStep;
          nodes.push({ at: [Math.round(nx2), Math.round(nz2)],
            y: +World.height[(gzi + j) * n2 + (gxi + i)].toFixed(3),
            carve: +isleCarve(nx2, nz2).toFixed(2),
            base: +isleBaseHeight(nx2, nz2).toFixed(2),
            waterCut: +isleWaterCut(isleBaseHeight(nx2, nz2), nx2, nz2).toFixed(2) });
        }
      }
      return { at: [x, z], base: +base.toFixed(3), waterCutValue: +cutV.toFixed(3),
        final: +World.heightAt(x, z).toFixed(3), carve: +isleCarve(x, z).toFixed(2),
        lots: LOTS.filter(function (l) {
          return Math.hypot(l.x - x, l.z - z) < l.r;
        }).map(function (l) {
          return { x: Math.round(l.x), z: Math.round(l.z), r: +l.r.toFixed(1), y: +l.y.toFixed(2),
            d: +Math.hypot(l.x - x, l.z - z).toFixed(1) };
        }),
        flats: FLATS.filter(function (f) {
          return Math.hypot(f.x - x, f.z - z) < f.r;
        }).map(function (f) {
          return { x: Math.round(f.x), z: Math.round(f.z), r: f.r, y: +f.y.toFixed(2),
            d: +Math.hypot(f.x - x, f.z - z).toFixed(1) };
        }),
        nodes: nodes };
    })();

    App.state = 'MENU';
    return out;
  })()`);

  console.log('  building: ' + JSON.stringify(res.building, null, 1));
  console.log('  corner: ' + JSON.stringify(res.corner, null, 1));
  console.log('  bridge: ' + JSON.stringify(res.bridge, null, 1));
  return res;
};
