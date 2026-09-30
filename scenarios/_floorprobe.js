// Focused probe: does the surface the player stands on match the surface the
// terrain mesh draws? World.heightAt() is a bilinear read of the heightmap while
// the mesh is drawn as triangles, and on a steep hill the two differ by a lot -
// which is exactly what "my player goes through the floor" looks like.
//
// It also checks which of the two possible triangle diagonals the mesh uses, so
// the collision query can be made to follow it.
module.exports = async function floorprobe(ctx) {
  const { evaluate, check } = ctx;

  const out = await evaluate(`(function () {
    var sizes = World.height ? World.height.length : 0;
    var r = { had: sizes, maps: {} };
    var qualities = ['low', 'med', 'high'];
    for (var q = 0; q < qualities.length; q++) {
      var key = qualities[q];
      World.build(QUALITY_PRESETS[key], 4242, 'surf');
      var segs = World.hN, step = World.hStep, half = World.hHalf;
      var n = segs + 1;
      function H(i, j) { return World.height[j * n + i]; }
      /* the two ways a quad can be split into triangles. A is the split
         PlaneGeometry builds (diagonal (i,j) -> (i+1,j+1)); B is the mirror. */
      function triA(x, z) {
        var gx = Math.min(Math.max((x + half) / step, 0), segs - 0.0001);
        var gz = Math.min(Math.max((z + half) / step, 0), segs - 0.0001);
        var i0 = Math.floor(gx), j0 = Math.floor(gz), fx = gx - i0, fz = gz - j0;
        var a = H(i0, j0), b = H(i0 + 1, j0), c = H(i0 + 1, j0 + 1), d = H(i0, j0 + 1);
        if (fx >= fz) return a + fx * (b - a) + fz * (c - b);      // corner (0,0),(1,0),(1,1)
        return d + fx * (c - d) + (1 - fz) * (a - d);              // corner (0,1),(0,0),(1,1)
      }
      function triB(x, z) {
        var gx = Math.min(Math.max((x + half) / step, 0), segs - 0.0001);
        var gz = Math.min(Math.max((z + half) / step, 0), segs - 0.0001);
        var i0 = Math.floor(gx), j0 = Math.floor(gz), fx = gx - i0, fz = gz - j0;
        var a = H(i0, j0), b = H(i0 + 1, j0), c = H(i0 + 1, j0 + 1), d = H(i0, j0 + 1);
        /* the split the index buffer really uses: (0,0),(0,1),(1,0) and
           (0,1),(1,1),(1,0) - the diagonal runs from (0,1) to (1,0) */
        if (fx + fz <= 1) return a + fx * (b - a) + fz * (d - a);
        return c + (1 - fx) * (d - c) + (1 - fz) * (b - c);
      }
      var ray = new THREE.Raycaster();
      var origin = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
      var worstBil = 0, worstA = 0, worstB = 0, worstAt = null, samples = 0;
      var above = 0, below = 0;
      for (var s = 0; s < 400; s++) {
        var a = Math.random() * 6.28, rad = Math.random() * 420;
        var x = Math.cos(a) * rad, z = Math.sin(a) * rad;
        var bil = World.heightAt(x, z);
        if (bil < 1) continue;                   // underwater: not a hill
        origin.set(x, bil + 60, z);
        ray.set(origin, down);
        var hits = ray.intersectObject(World.terrain, false);
        if (!hits.length) continue;
        var mesh = hits[0].point.y;
        samples++;
        var eBil = mesh - bil, eA = mesh - triA(x, z), eB = mesh - triB(x, z);
        if (Math.abs(eBil) > Math.abs(worstBil)) { worstBil = eBil; worstAt = { x: +x.toFixed(1), z: +z.toFixed(1), mesh: +mesh.toFixed(2), bil: +bil.toFixed(2) }; }
        if (Math.abs(eA) > Math.abs(worstA)) worstA = eA;
        if (Math.abs(eB) > Math.abs(worstB)) worstB = eB;
        if (eBil > 0.05) above++;                // mesh above the collision surface
        else if (eBil < -0.05) below++;
      }
      r.maps[key] = { segs: segs, step: +step.toFixed(2), samples: samples,
        worstBil: +worstBil.toFixed(2), worstA: +worstA.toFixed(3), worstB: +worstB.toFixed(3),
        meshAboveBilinear: above, meshBelowBilinear: below, at: worstAt };
    }
    /* back to whatever map the page was on before the probe */
    World.build(QUALITY_PRESETS[SETTINGS.quality] || QUALITY_PRESETS.high, 7, 'isle');
    return r;
  })()`);

  console.log('  floor probe: ' + JSON.stringify(out));
  check('probe ran on all three quality presets', Object.keys(out.maps).length === 3,
    Object.keys(out.maps).join(','));
  return out;
};
