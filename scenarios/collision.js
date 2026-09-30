// Collision scenario: no invisible walls ("stuck on air"), structures block
// where they should, and the building doors are real gaps.
const PASSABLE = `(function () {
  /* walk a 0.42-radius player circle into the point; report whether the world
     pushed it back (blocked) or left it alone (passable) */
  return function (x, z, y) {
    var p = { x: x, z: z };
    var moved = World.resolve(p, 0.42, y, y + 1.8);
    return { blocked: moved, movedTo: { x: +p.x.toFixed(2), z: +p.z.toFixed(2) } };
  };
})()`;

module.exports = async function collision(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1400);

  /* ---------------- no giant colliders ---------------- */
  const size = await evaluate(`(function () {
    var worst = { hx: 0, hz: 0, r: 0 };
    for (var i = 0; i < World.colliders.length; i++) {
      var c = World.colliders[i];
      if (c.cyl) { if (c.r > worst.r) worst.r = c.r; }
      else { if (c.hx > worst.hx) worst.hx = c.hx; if (c.hz > worst.hz) worst.hz = c.hz; }
    }
    return { worst: worst, total: World.colliders.length,
             map: World.mapId, scale: Math.max(1, World.contentScale) };
  })()`);
  console.log('  collider sizes: ' + JSON.stringify(size));
  /* The bound exists to catch the crashed-plane wing, which used to be a single
     26 m box (half-extent 13) that walled off a square of empty air. Surf City's
     dam is a genuinely long structure - 110 m of wall - so it is counted
     separately: long and thin is the dam, long and wide is the bug. The count
     itself scales with the map (ISLE ROYALE is four times the ground and carries
     roughly twice Surf City's colliders), so the ceiling scales with it too. */
  const giants = await evaluate(`(function () {
    var wide = 0, longThin = 0, worstWide = null;
    for (var i = 0; i < World.colliders.length; i++) {
      var c = World.colliders[i];
      if (c.cyl) continue;
      if (c.hx > 9 && c.hz > 9) { wide++; if (!worstWide) worstWide = { hx: c.hx, hz: c.hz }; }
      else if (c.hx >= 20 && c.hz <= 10) longThin++;
      else if (c.hz >= 20 && c.hx <= 10) longThin++;
    }
    return { wide: wide, longThin: longThin, worstWide: worstWide, map: World.mapId };
  })()`);
  check('no collider is wider than a real structure (the wing was a 26 m box)',
    giants.wide === 0, giants.wide + ' wide box(es) on ' + giants.map +
    (giants.worstWide ? ' ' + JSON.stringify(giants.worstWide) : ''));
  check('the only long colliders are the dam and its kind', giants.longThin <= 12,
    giants.longThin + ' long-thin collider(s)');
  check('no collider is a giant cylinder (was 13 m on the wing)',
    size.worst.r <= 6.5, 'widest cylinder radius ' + size.worst.r + ' m');
  check('the collider count is sane', size.total > 400 && size.total < 2400 * size.scale,
    size.total + ' colliders on ' + size.map + ' (ceiling ' + 2400 * size.scale + ')');

  /* ---------------- the plane wing is passable on the ground ---------------- */
  const wing = await evaluate(`(function () {
    var passable = ${PASSABLE};
    var lm = null;
    for (var i = 0; i < World.landmarks.length; i++) if (World.landmarks[i].type === 'plane') lm = World.landmarks[i];
    if (!lm) return { err: 'no plane landmark' };
    var ry = lm.rot;
    var wx = Math.sin(ry), wz = Math.cos(ry);       // short axis of the wing
    var dx = -wx, dz = wz;                          // its long axis
    var y = World.heightAt(lm.x, lm.z);
    /* which colliders touch a player circle at (x,z,fy)? The wing lives above
       head height, so any blocker with a base at ground level is real geometry
       (fuselage, debris, the tail) and only the wing would be an invisible wall. */
    var blocker = function (x, z, fy) {
      var near = World.grid.query(x, z, 1.8, []);
      for (var i = 0; i < near.length; i++) {
        var c = near[i];
        if (c.y1 <= fy + 0.62 || c.y0 >= fy + 1.8) continue;
        var d;
        if (c.cyl) d = Math.hypot(x - c.x, z - c.z) - c.r;
        else {
          var px = Math.max(c.x - c.hx, Math.min(c.x + c.hx, x));
          var pz = Math.max(c.z - c.hz, Math.min(c.z + c.hz, z));
          d = Math.hypot(x - px, z - pz) - 0.42;
        }
        if (d < 0.42) return { base: +(c.y0 - y).toFixed(2), cyl: !!c.cyl, r: c.r || c.hx };
      }
      return null;
    };
    var airBlocks = 0, realBlocks = 0, free = 0, n = 0;
    for (var d = -9.9; d <= 9.9; d += 2.2) {
      if (Math.abs(d) < 1.5) continue;          // the fuselage sits at the wing's centre
      n++;
      var b = blocker(lm.x + wx * 3 + dx * d, lm.z + wz * 3 + dz * d, y);
      if (!b) free++;
      else if (b.base >= 1.85) airBlocks++;      // the wing itself: above head height
      else realBlocks++;                         // a real object on the ground
    }
    var blockedRays = 0;
    for (var d = -11; d <= 11; d += 2.2) {
      var ax = lm.x + wx * 3 + dx * d, az = lm.z + wz * 3 + dz * d;
      var h = World.raycast(ax - wz * 3, y + 2.6, az - wx * 3, wz, 0, wx, 6);
      if (h.t >= 0) blockedRays++;
    }
    return { airBlocks: airBlocks, realBlocks: realBlocks, free: free, n: n,
             blockedRays: blockedRays };
  })()`);
  console.log('  wing: ' + JSON.stringify(wing));
  check('the crashed-plane wing never blocks the ground under it', wing.airBlocks === 0,
    wing.airBlocks + '/' + wing.n + ' invisible-wall points (' + wing.free + ' free, ' +
    wing.realBlocks + ' blocked by real geometry)');
  check('the wing still blocks bullets / line of sight', wing.blockedRays >= 8,
    wing.blockedRays + '/11 rays blocked');

  /* ---------------- a fence hugs its rail; no giant square next to it ---------------- */
  const fence = await evaluate(`(function () {
    var passable = ${PASSABLE};
    var fences = [];
    for (var i = 0; i < World.colliders.length; i++) {
      var c = World.colliders[i];
      if (c.cyl && c.r <= 0.34) fences.push(c);
    }
    if (fences.length < 6) return { err: 'no fence cylinders found (' + fences.length + ')' };
    var f = fences[Math.floor(fences.length / 2)];
    var y = World.heightAt(f.x, f.z);
    var onLine = 0;
    for (var a = 0; a < 6; a++) {
      if (passable(f.x + Math.cos(a) * 0.05, f.z + Math.sin(a) * 0.05, y).blocked) onLine++;
    }
    /* beside the fence means perpendicular to the rail, not along it */
    var nb = null;
    for (var i = 0; i < fences.length; i++) {
      var dd = Math.hypot(fences[i].x - f.x, fences[i].z - f.z);
      if (dd > 0.5 && dd < 1.6) { nb = fences[i]; break; }
    }
    var px = 1, pz = 0;
    if (nb) {
      var ddx = nb.x - f.x, ddz = nb.z - f.z, l = Math.hypot(ddx, ddz);
      px = -ddz / l; pz = ddx / l;
    }
    var awayBlocked = 0;
    for (var side = -1; side <= 1; side += 2) {
      var ox = f.x + px * 2.4 * side, oz = f.z + pz * 2.4 * side;
      var ry = World.heightAt(ox, oz);
      if (ry > 1.5 && passable(ox, oz, ry).blocked) awayBlocked++;
    }
    return { fenceCount: fences.length, onLine: onLine, awayBlocked: awayBlocked };
  })()`);
  console.log('  fence: ' + JSON.stringify(fence));
  check('fence colliders exist as a tight chain', !fence.err && fence.fenceCount >= 6,
    fence.err || fence.fenceCount + ' fence segments');
  check('the fence line itself blocks you', fence.onLine >= 5, fence.onLine + '/6 on-line points');
  check('the air beside the fence is free', fence.awayBlocked <= 1,
    fence.awayBlocked + ' beside-fence points blocked' +
    ' (a prop or a wall may legitimately stand next to a fence)');

  /* ---------------- building walls block, the door lets you in ---------------- */
  const door = await evaluate(`(function () {
    var passable = ${PASSABLE};
    var bd = World.towns[0].buildings[0];
    var y = bd.y;
    /* step from just outside each wall face to just inside it */
    var sides = [
      { x: bd.x - bd.w / 2 - 0.6, z: bd.z, nx: 1, nz: 0 },   // west face, walk in +X
      { x: bd.x + bd.w / 2 + 0.6, z: bd.z, nx: -1, nz: 0 },   // east face, walk in -X
      { x: bd.x, z: bd.z - bd.d / 2 - 0.6, nx: 0, nz: 1 },   // north face, walk in +Z
      { x: bd.x, z: bd.z + bd.d / 2 + 0.6, nx: 0, nz: -1 }    // south face, walk in -Z
    ];
    var blockedSides = 0, passableSides = 0, blocked = [];
    for (var i = 0; i < 4; i++) {
      var s = sides[i];
      var inside = passable(s.x + s.nx * 1.0, s.z + s.nz * 1.0, y);
      if (inside.blocked) { blockedSides++; blocked.push(i); } else passableSides++;
    }
    return { blockedSides: blockedSides, passableSides: passableSides, blocked: blocked,
             building: { w: bd.w, d: bd.d, y: bd.y } };
  })()`);
  console.log('  building: ' + JSON.stringify(door));
  check('most building sides block you', door.blockedSides >= 3, door.blockedSides + '/4 sides blocked');
  check('one building side has a real door gap', door.passableSides >= 1,
    door.passableSides + '/4 sides passable');

  /* ---------------- you never spawn buried inside a collider ---------------- */
  const wedged = await evaluate(`(function () {
    /* Sample the island at ground level. Landing inside a rock or a pier leg is
       legitimate (the resolver pushes you out); what must never happen is the
       old giant-invisible-box case, where a point is thrown many metres out of
       empty air because a collider is far bigger than the thing it stands for. */
    var buried = 0, samples = 0, worstPush = 0, worstAt = null;
    for (var t = 0; t < 600; t++) {
      var a = Math.random() * 6.28, r = Math.random() * 380;
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      var y = World.heightAt(x, z);
      if (y < 2.0) continue;
      var p = { x: x, z: z };
      World.resolve(p, 0.42, y, y + 1.8);
      var moved = Math.hypot(p.x - x, p.z - z);
      samples++;
      if (moved > 0.9) buried++;
      if (moved > worstPush) { worstPush = moved; worstAt = { x: Math.round(x), z: Math.round(z) }; }
    }
    return { samples: samples, buried: buried, fraction: +(buried / samples).toFixed(3),
             worstPush: +worstPush.toFixed(2), worstAt: worstAt };
  })()`);
  console.log('  walkability: ' + JSON.stringify(wedged));
  check('almost every ground point is walkable', wedged.fraction <= 0.06,
    (wedged.fraction * 100).toFixed(1) + '% of ' + wedged.samples + ' points sit inside a prop');
  check('no invisible-box push-outs (the old 26 m wing bug)', wedged.worstPush <= 8,
    'worst push ' + wedged.worstPush + ' m at ' + JSON.stringify(wedged.worstAt));
};
