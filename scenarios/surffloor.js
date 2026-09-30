// Surf City's hills: the surface the player stands on has to be the surface the
// renderer draws. The collision query used to read a bilinear patch of the
// heightmap while the mesh is drawn as triangles, which on a broken slope pushed
// the visible ground metres above the walkable surface - you slid down a hill
// and sank into it.
//
// Two things are checked: the query matches a raycast onto the real terrain mesh
// on every quality preset, and a player sent down the steepest hill on the map
// never ends a frame below that mesh.
module.exports = async function surffloor(ctx) {
  const { evaluate, check } = ctx;

  /* ---------------- 1. query vs. the mesh the renderer draws ---------------- */
  const probe = await evaluate(`(function () {
    var qualities = ['low', 'med', 'high'];
    var out = {};
    for (var q = 0; q < qualities.length; q++) {
      World.build(QUALITY_PRESETS[qualities[q]], 4242, 'surf');
      var ray = new THREE.Raycaster();
      var origin = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
      var worst = 0, worstBilinear = 0, samples = 0, at = null;
      for (var s = 0; s < 500; s++) {
        var a = Math.random() * 6.28, rad = Math.random() * 420;
        var x = Math.cos(a) * rad, z = Math.sin(a) * rad;
        var h = World.heightAt(x, z);
        if (h < 1) continue;                       // water, not a hill
        origin.set(x, h + 60, z);
        ray.set(origin, down);
        var hits = ray.intersectObject(World.terrain, false);
        if (!hits.length) continue;
        samples++;
        var gap = hits[0].point.y - h;
        if (Math.abs(gap) > Math.abs(worst)) { worst = gap; at = { x: +x.toFixed(1), z: +z.toFixed(1) }; }
        /* how far the old bilinear read would have been out */
        var n = World.hN + 1, step = World.hStep, half = World.hHalf;
        var gx = Math.min(Math.max((x + half) / step, 0), World.hN - 0.0001);
        var gz = Math.min(Math.max((z + half) / step, 0), World.hN - 0.0001);
        var i0 = Math.floor(gx), j0 = Math.floor(gz), fx = gx - i0, fz = gz - j0;
        var H = function (i, j) { return World.height[j * n + i]; };
        var bil = (H(i0, j0) * (1 - fx) + H(i0 + 1, j0) * fx) * (1 - fz) +
                  (H(i0, j0 + 1) * (1 - fx) + H(i0 + 1, j0 + 1) * fx) * fz;
        var bgap = hits[0].point.y - bil;
        if (Math.abs(bgap) > Math.abs(worstBilinear)) worstBilinear = bgap;
      }
      out[qualities[q]] = { samples: samples, worst: +worst.toFixed(3),
                            worstBilinear: +worstBilinear.toFixed(2), at: at };
    }
    return out;
  })()`);
  console.log('  mesh vs ground query: ' + JSON.stringify(probe));

  const worstAll = Math.max(Math.abs(probe.low.worst), Math.abs(probe.med.worst),
                            Math.abs(probe.high.worst));
  check('the ground query agrees with the drawn terrain (all presets)',
    worstAll <= 0.05, 'worst ' + worstAll.toFixed(3) + ' m off the mesh');
  const worstBilinear = Math.max(Math.abs(probe.low.worstBilinear),
                                 Math.abs(probe.med.worstBilinear),
                                 Math.abs(probe.high.worstBilinear));
  check('a bilinear query would NOT have: the two surfaces really do diverge',
    worstBilinear > 0.3, 'up to ' + worstBilinear.toFixed(2) + ' m apart (the old bug)');

  /* ---------------- 2. run the player down the steepest hill ---------------- */
  const slide = await evaluate(`(function () {
    var out = {};
    var qualities = ['high', 'low'];
    for (var q = 0; q < qualities.length; q++) {
      World.build(QUALITY_PRESETS[qualities[q]], 909, 'surf');
      /* steepest walkable downhill lane on the map */
      var best = null;
      for (var x = -300; x <= 300; x += 7) {
        for (var z = -300; z <= 300; z += 7) {
          var h = World.heightAt(x, z);
          if (h < 4 || h > 45) continue;
          var hx = World.heightAt(x + 5, z), hz = World.heightAt(x, z + 5);
          var g = Math.sqrt((hx - h) * (hx - h) + (hz - h) * (hz - h)) / 5;
          var p = { x: x, z: z };                    // has to be walkable ground
          if (World.resolve(p, 0.42, h, h + 1.8)) continue;
          if (!best || g > best.g) best = { x: x, z: z, h: h, g: g, dx: hx - h, dz: hz - h };
        }
      }
      if (!best) { out[qualities[q]] = { err: 'no hill found' }; continue; }
      /* face straight down the fall line and hold W */
      var yaw = Math.atan2(-best.dx, best.dz);
      Player.alive = true; Player.hp = 1e9; Player.shield = 0;
      Player.pos.set(best.x, best.h, best.z);
      Player.vel.set(0, 0, 0);
      Player.airborne = false; Player.gliderOpen = false;
      Player.grounded = true; Player.crouching = false;
      CAM.yaw = yaw; CAM.pitch = 0; CAM.sync();
      Player.yaw = yaw;
      var keys = Input.keys;
      Input.keys = { fwd: true }; Input.analog.x = 0; Input.analog.z = 1; Input.updateAxes();

      var ray = new THREE.Raycaster();
      var origin = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
      function meshY(x, z) {
        origin.set(x, World.heightAt(x, z) + 80, z);
        ray.set(origin, down);
        var hit = ray.intersectObject(World.terrain, false);
        return hit.length ? hit[0].point.y : World.heightAt(x, z);
      }
      var worstSink = -1e9, framesUnder = 0, n = 0, y0 = Player.pos.y;
      for (var i = 0; i < 240; i++) {
        Player.update(1 / 60);
        var sink = meshY(Player.pos.x, Player.pos.z) - Player.pos.y;
        if (sink > worstSink) worstSink = sink;       // >0: the player is in the ground
        if (sink > 0.15) framesUnder++;
        n++;
      }
      var travelled = Math.hypot(Player.pos.x - best.x, Player.pos.z - best.z);
      Input.keys = keys; Input.analog.z = 0; Input.updateAxes();
      out[qualities[q]] = { slope: +best.g.toFixed(2), drop: +(y0 - Player.pos.y).toFixed(1),
        travelled: +travelled.toFixed(1), frames: n, worstSink: +worstSink.toFixed(3),
        framesUnder: framesUnder, at: { x: +best.x.toFixed(0), z: +best.z.toFixed(0) } };
    }
    return out;
  })()`);
  console.log('  hill slide: ' + JSON.stringify(slide));

  ['high', 'low'].forEach(function (q) {
    const r = slide[q];
    if (!r || r.err) { check('found a hill to slide down (' + q + ')', false, r ? r.err : 'missing'); return; }
    check('the player really slides down the hill (' + q + ' preset)',
      r.travelled > 5 && r.drop > 1, JSON.stringify(r));
    check('his feet never drop through the visible floor (' + q + ' preset)',
      r.worstSink <= 0.15, 'worst ' + r.worstSink + ' m under the mesh over ' + r.frames + ' frames');
  });
};

