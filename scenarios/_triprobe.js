// Focused probe: which diagonal does the terrain mesh really split its quads
// on? Reads the mesh's own index buffer instead of guessing.
module.exports = async function triprobe(ctx) {
  const { evaluate, check } = ctx;

  const out = await evaluate(`(function () {
    World.build(QUALITY_PRESETS.high, 4242, 'surf');
    var g = World.terrain.geometry;
    var pos = g.attributes.position, idx = g.index.array;
    var step = World.hStep, half = World.hHalf, segs = World.hN, n = segs + 1;
    /* pick a cell in the hilly north of Surf City */
    var x0 = 60.3, z0 = -180.7;
    var i0 = Math.floor((x0 + half) / step), j0 = Math.floor((z0 + half) / step);
    /* find the vertex index of each of the four lattice corners */
    function findVertex(x, z) {
      for (var v = 0; v < pos.count; v++) {
        if (Math.abs(pos.getX(v) - x) < 1e-6 && Math.abs(pos.getZ(v) - z) < 1e-6) return v;
      }
      return -1;
    }
    function lattice(i, j) { return { x: -half + i * step, z: -half + j * step }; }
    var corners = [];   // [i, j, vertexIndex, y]
    var pts = [[i0, j0], [i0 + 1, j0], [i0, j0 + 1], [i0 + 1, j0 + 1]];
    for (var k = 0; k < 4; k++) {
      var p = lattice(pts[k][0], pts[k][1]);
      var v = findVertex(p.x, p.z);
      corners.push({ i: pts[k][0], j: pts[k][1], v: v, y: v >= 0 ? +pos.getY(v).toFixed(3) : null });
    }
    /* every triangle that uses two or more of those corners */
    var tris = [];
    for (var t = 0; t < idx.length; t += 3) {
      var a = idx[t], b = idx[t + 1], c = idx[t + 2];
      var use = 0;
      for (var k2 = 0; k2 < 4; k2++) if (corners[k2].v === a || corners[k2].v === b || corners[k2].v === c) use++;
      if (use >= 3) {
        tris.push({ i: t / 3, verts: [a, b, c],
          xyz: [a, b, c].map(function (v) {
            return [+pos.getX(v).toFixed(2), +pos.getY(v).toFixed(2), +pos.getZ(v).toFixed(2)];
          }) });
      }
    }
    /* does the index buffer cover both triangles of this cell? */
    var heightmap = [];
    for (var k3 = 0; k3 < 4; k3++) {
      heightmap.push(+World.height[corners[k3].j * n + corners[k3].i].toFixed(3));
    }
    return { cell: { i0: i0, j0: j0, x: +(-half + (i0 + 0.5) * step).toFixed(2), z: +(-half + (j0 + 0.5) * step).toFixed(2) },
             corners: corners, heightmap: heightmap, triangles: tris,
             indexCount: idx.length, vertexCount: pos.count, expectedQuads: segs * segs };
  })()`);

  console.log('  triprobe: ' + JSON.stringify(out));
  check('probe read the terrain index buffer', out.triangles.length >= 2, out.triangles.length + ' triangles in the cell');
  return out;
};
