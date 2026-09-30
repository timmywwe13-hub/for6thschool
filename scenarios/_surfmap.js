// Terrain-shape probe for Surf City. Prints an ASCII height map of the built
// island plus, for every 10-degree bearing, the radius the shoreline table asks
// for against the radius the terrain actually reaches. Also counts how much of
// the intended island is below sea level (which is what makes the lower half of
// the map read as flooded) and how many road samples sit over water.
//
//   node cdp-test.js _surfmap
const fs = require('fs');
const path = require('path');

module.exports = async function surfmap(ctx) {
  const { evaluate, check } = ctx;
  const res = await evaluate(`(function () {
    World.build(QUALITY_PRESETS.low, 1234, 'surf');
    var R = CONFIG.ISLAND_RADIUS, N = 74, span = 1000, half = span / 2, step = span / N;
    function ch(h) {
      if (h < -9) return '~';        // deep sea / lake bottom
      if (h < -1.5) return '=';      // water
      if (h < 1.4) return ':';       // wet sand
      if (h < 3.6) return '.';       // beach
      if (h < 15) return '-';        // grass
      if (h < 34) return '+';        // highland
      return '^';                    // rock cap
    }
    var rows = [];
    for (var j = 0; j < N; j++) {
      var z = -half + (j + 0.5) * step, line = '';
      for (var i = 0; i < N; i++) {
        line += ch(shapedHeight(-half + (i + 0.5) * step, z));
      }
      rows.push(line);
    }

    /* intended shoreline (the reference silhouette) vs the land that is
       actually dry, per bearing */
    var rays = [];
    for (var b = 0; b < 36; b++) {
      var a = b * Math.PI / 18;
      var want = surfShoreR(a);
      var got = 0;
      for (var d = 20; d < 470; d += 3) {
        if (shapedHeight(Math.cos(a) * d, Math.sin(a) * d) > 0) got = d;
      }
      rays.push({ deg: Math.round(b * 10), want: Math.round(want), got: Math.round(got),
                  diff: Math.round(got - want) });
    }

    /* how much of the intended island ends up underwater, by quadrant. Water
       that a lake / river / creek actually carves is expected - only the
       "accidental" water, land that sank on its own, is a problem. */
    var wet = 0, tot = 0, wetSouth = 0, totSouth = 0, wetBand = [0, 0, 0, 0], totBand = [0, 0, 0, 0];
    var acc = 0, accSouth = 0, accAt = [];
    var lowest = 1e9, lowestAt = null;
    for (var z2 = -half; z2 < half; z2 += 8) {
      for (var x2 = -half; x2 < half; x2 += 8) {
        var dd = Math.sqrt(x2 * x2 + z2 * z2);
        if (dd > surfShoreR(Math.atan2(z2, x2)) * 0.94) continue;   // only inside the silhouette
        var h = shapedHeight(x2, z2), cut = surfCarve(x2, z2);
        tot++;
        var band = z2 < 0 ? (x2 < 0 ? 0 : 1) : (x2 < 0 ? 2 : 3);
        totBand[band]++;
        if (h < -1.5) { wet++; wetBand[band]++; }
        if (h < 0 && cut < 1) {
          acc++;
          if (z2 > 0) accSouth++;
          if (accAt.length < 10) accAt.push([Math.round(x2), Math.round(z2), Math.round(h)]);
        }
        if (z2 > 0) { totSouth++; if (h < -1.5) wetSouth++; }
        if (h < lowest) { lowest = h; lowestAt = [Math.round(x2), Math.round(z2)]; }
      }
    }

    /* road samples that land on water (the terrain tint stops at h <= 0.4, so
       these show up as gaps in the road). The two bridges and the dam crest are
       deliberate crossings, so samples near them are ignored. */
    var CROSS = [[80, 90, 40], [59, 343, 40], [110, -190, 60]];
    var roadPts = 0, roadWet = 0, roadLow = [];
    for (var r = 0; r < World.roads.length; r++) {
      var line = World.roads[r];
      for (var p = 0; p < line.length - 1; p++) {
        var L = Math.hypot(line[p + 1][0] - line[p][0], line[p + 1][1] - line[p][1]);
        var n = Math.max(2, Math.ceil(L / 6));
        for (var k = 0; k <= n; k++) {
          var t = k / n;
          var rx = line[p][0] + (line[p + 1][0] - line[p][0]) * t;
          var rz = line[p][1] + (line[p + 1][1] - line[p][1]) * t;
          var span = false;
          for (var c = 0; c < CROSS.length; c++) {
            if (Math.hypot(rx - CROSS[c][0], rz - CROSS[c][1]) < CROSS[c][2]) span = true;
          }
          if (span) continue;
          roadPts++;
          if (shapedHeight(rx, rz) < 0.5) {
            roadWet++;
            if (roadLow.length < 24) {
              roadLow.push([Math.round(rx), Math.round(rz),
                Math.round(shapedHeight(rx, rz)), Math.round(surfCarve(rx, rz)),
                Math.round(Math.sqrt(rx * rx + rz * rz)),
                Math.round(surfShoreR(Math.atan2(rz, rx)))]);
            }
          }
        }
      }
    }

    return {
      map: rows.join('\\n'),
      rays: rays,
      wetPct: Math.round(100 * wet / Math.max(1, tot)),
      wetSouthPct: Math.round(100 * wetSouth / Math.max(1, totSouth)),
      wetByQuad: wetBand.map(function (w, i) { return Math.round(100 * w / Math.max(1, totBand[i])); }),
      lowest: Math.round(lowest), lowestAt: lowestAt,
      roadSegs: World.roads.length, roadPts: roadPts, roadWet: roadWet, roadLow: roadLow,
      accPct: Math.round(1000 * acc / Math.max(1, tot)) / 10,
      accSouthPct: Math.round(1000 * accSouth / Math.max(1, totSouth)) / 10,
      accAt: accAt,
      cities: World.towns.map(function (t) {
        return t.name + ' @' + Math.round(t.x) + ',' + Math.round(t.z) +
               ' y' + World.heightAt(t.x, t.z).toFixed(1) + ' n' + t.buildings.length;
      }),
      landmarks: World.landmarks.map(function (l) {
        return l.name + ' @' + Math.round(l.x) + ',' + Math.round(l.z) +
               ' y' + World.heightAt(l.x, l.z).toFixed(1);
      })
    };
  })()`);

  console.log('\n=== terrain (north at the top, x east to the right) ===');
  console.log('    ~ deep water   = water   : wet sand   . beach   - grass   + highland   ^ rock');
  const lines = res.map.split('\n');
  lines.forEach((l, i) => console.log('  ' + l + '   z ' + Math.round(-500 + (i + 0.5) * (1000 / lines.length))));
  console.log('\n=== intended shore radius (table) vs dry land (terrain) ===');
  res.rays.forEach(r => {
    const flag = r.diff < -30 ? '  <-- land short of the reference outline'
                              : (r.diff > 30 ? '  <-- land past the reference outline' : '');
    console.log(`  ${String(r.deg).padStart(3)}deg  want ${String(r.want).padStart(3)}  got ${String(r.got).padStart(3)}  diff ${String(r.diff).padStart(4)}${flag}`);
  });
  console.log('\n=== flooding / roads ===');
  console.log('  intended island underwater:            ' + res.wetPct + '%  (lake + river count as water)');
  console.log('  southern half underwater:              ' + res.wetSouthPct + '%');
  console.log('  by quadrant (NW, NE, SW, SE):          ' + res.wetByQuad.join('%  ') + '%');
  console.log('  ACCIDENTAL water (no water body there): ' + res.accPct + '%  south ' +
              res.accSouthPct + '%  at ' + JSON.stringify(res.accAt));
  console.log('  lowest land inside the silhouette:     ' + res.lowest + ' at ' + JSON.stringify(res.lowestAt));
  console.log('  road samples over water:               ' + res.roadWet + '/' + res.roadPts);
  console.log('     x, z, height, carve, dist, shoreRadius');
  res.roadLow.forEach(r => console.log('     ' + JSON.stringify(r)));
  console.log('  roads:                                 ' + res.roadSegs + ' polylines');
  console.log('  towns:                                 ' + res.cities.join('\n                                         '));
  console.log('  landmarks:                             ' + res.landmarks.join('\n                                         '));
  fs.writeFileSync(path.join(__dirname, '..', 'playtest', '_surfmap.txt'),
    res.map + '\n');

  check('surf city terrain probe ran', res.rays.length === 36, res.rays.length + ' bearings');
};
