// Focused probe: why did the building door test find 0/4 sides blocked?
module.exports = async function bldgprobe(ctx) {
  const { evaluate, check, sleep } = ctx;
  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1400);

  const out = await evaluate(`(function () {
    var town = World.towns[0];
    var bd = town.buildings[0];
    var r = { town: town.name, bd: { x: bd.x, z: bd.z, w: bd.w, d: bd.d, y: bd.y, floors: bd.floors } };
    r.heightmapCentre = +World.heightAt(bd.x, bd.z).toFixed(2);
    /* every collider within 10 m of the centre */
    var near = [];
    World.grid.query(bd.x, bd.z, 12, []);
    var q = World.grid.query(bd.x, bd.z, 12, []);
    for (var i = 0; i < q.length; i++) {
      var c = q[i];
      near.push({ x: +c.x.toFixed(1), z: +c.z.toFixed(1),
                  hx: c.cyl ? c.r : +c.hx.toFixed(2), hz: c.cyl ? c.r : +c.hz.toFixed(2),
                  cyl: !!c.cyl, y0: +c.y0.toFixed(1), y1: +c.y1.toFixed(1) });
    }
    r.nearColliders = near.slice(0, 10);
    r.nearCount = near.length;
    /* step inside the west wall face */
    var sides = [];
    var sx = [bd.x - bd.w / 2, bd.x + bd.w / 2, bd.x, bd.x];
    var sz = [bd.z, bd.z, bd.z - bd.d / 2, bd.z + bd.d / 2];
    var nx = [-1, 1, 0, 0], nz = [0, 0, -1, 1];
    for (var i = 0; i < 4; i++) {
      var p = { x: sx[i] + nx[i] * 0.4, z: sz[i] + nz[i] * 0.4 };   // 0.4 inside the face
      var before = { x: p.x, z: p.z };
      var hit = World.resolve(p, 0.42, bd.y, bd.y + 1.8);
      sides.push({ side: i, hit: hit, moved: +Math.hypot(p.x - before.x, p.z - before.z).toFixed(2) });
    }
    r.sides = sides;
    return r;
  })()`);
  console.log(JSON.stringify(out, null, 1));
  check('probe ran', !out.err, 'ok');
};
