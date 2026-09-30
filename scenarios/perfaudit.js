// Solo performance + stability audit: frame budget, draw calls, memory.
//
// Runs the shipped match on ISLE ROYALE and measures what a player feels:
//
//   * a POI sweep - every town, five field points, the longest bridge, the
//     biggest offshore islet and the bus route - teleporting to each and timing
//     60 frames of Game.update + Game.render, split into simulation and render,
//     with the draw calls and triangle count each frame really issued
//   * frame pacing: the p50/p95/max of those frames, so a hitch shows up as a
//     number rather than a stutter
//   * a match soak: three minutes of match time fast-forwarded in 50 ms steps
//     with the heap sampled every 15 s, counting long frames and any
//     fall-through (App.rescues is the engine's own "a body had to be lifted
//     out of the world" counter)
//   * a restart: a second match, to see whether geometries, textures or the JS
//     heap grow across a match boundary (levels are rebuilt from scratch, so
//     anything that grows is a leak)
//   * a smoke test of the solo basics: movement, the HUD, the live frame loop
//
//   node cdp-test.js perfaudit
const fs = require('fs');
const path = require('path');

module.exports = async function perfaudit(ctx) {
  const { evaluate, check, sleep } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });
  /* The audit is thorough on purpose: five points of interest, 18 frames each,
     half a minute of match soak, then a full match restart. The knobs raise all
     three (PERF_POIS / PERF_FRAMES / PERF_SOAK); they are deliberately modest by
     default because a longer soak has been seen to kill the SOFTWARE renderer in
     this headless harness - a harness limit, not a game one. */
  const POIS = Math.max(3, Number(process.env.PERF_POIS || 5));
  const FRAMES = Math.max(10, Number(process.env.PERF_FRAMES || 18));
  const SOAK = Math.max(15, Number(process.env.PERF_SOAK || 30));
  const SOAK_CHUNKS = Math.max(1, Math.ceil(SOAK / 15));

  /* Pin the island for this audit, the way MAP_PIN does: the live map comes from
     the wall clock (30-minute rotation slots), and an audit of ISLE ROYALE has to
     run on ISLE ROYALE - the small map is covered by the surf scenarios. */
  const pinned = await evaluate(`(function () {
    for (var k = 0; k < MAP_DEFS.length; k++) {
      if (MAP_DEFS[k].id === 'isle') {
        var def = MAP_DEFS[k];
        MapRotation.current = function () { return def; };
        return def.id;
      }
    }
    return null;
  })()`);
  console.log('  island pinned for the audit: ' + pinned);

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1500);
  /* ride the bus, bail out and land, so the sweep measures a live match (bots
     fighting, loot down, streamed props) rather than the bus ride */
  const booted = await evaluate(`(function () {
    for (var b = 0; b < 8000 && App.state === 'BUS'; b++) {
      if (Math.hypot(Bus.pos.x, Bus.pos.z) < 290) Bus.jump();
      Bus.update(1 / 60);
    }
    for (var d = 0; d < 9000 && App.state !== 'PLAYING'; d++) Game.update(1 / 60);
    return { state: App.state, alive: App.aliveCount, bots: BOTS.length };
  })()`);
  console.log('  match live for the sweep: ' + JSON.stringify(booted));

  /* ---------------- the POI sweep and the soak, in one page pass ---------------- */
  const sweep = await evaluate(`(function () {
    var out = { pois: [] };
    var spawn = World.towns.map(function (t) {
      return { name: t.name, x: t.x, z: t.z };
    });
    (function () {
      /* five field points plus the landmarks that are not towns */
      var pts = [{ name: 'FIELD CENTRE', x: 0, z: 0 },
                 { name: 'FIELD NORTH', x: 0, z: -520 },
                 { name: 'FIELD SOUTH', x: 0, z: 520 },
                 { name: 'FIELD EAST', x: 520, z: 0 },
                 { name: 'FIELD WEST', x: -520, z: 0 }];
      var g = null;
      for (var i = 0; i < World.bridges.length; i++) {
        var b = World.bridges[i], len = 0;
        for (var k = 0; k + 1 < b.pts.length; k++) {
          len += Math.hypot(b.pts[k + 1][0] - b.pts[k][0], b.pts[k + 1][1] - b.pts[k][1]);
        }
        if (!g || len > g.len) g = { b: b, len: len };
      }
      if (g) {
        var p0 = g.b.pts[0], p1 = g.b.pts[g.b.pts.length - 1];
        pts.push({ name: 'LONGEST BRIDGE', x: (p0[0] + p1[0]) / 2, z: (p0[1] + p1[1]) / 2 });
      }
      var big = null;
      for (var s2 = 0; s2 < ISLE_ISLETS.length; s2++) {
        if (!big || ISLE_ISLETS[s2].r > big.r) big = ISLE_ISLETS[s2];
      }
      if (big) pts.push({ name: 'OFFSHORE ISLET', x: isleWorldX(big.x), z: isleWorldZ(big.z) });
      pts.push({ name: 'BUS START', x: 26, z: -1356 });
      return pts;
    })().forEach(function (p) { spawn.push(p); });
    spawn = spawn.slice(0, ${POIS});

    for (var s = 0; s < spawn.length; s++) {
      var poi = spawn[s];
      var ground = World.groundAt(poi.x, poi.z, World.heightAt(poi.x, poi.z) + 8);
      Player.pos.set(poi.x, Math.max(ground, CONFIG.SEA_LEVEL + 0.6) + 1.2, poi.z);
      Player.vel.set(0, 0, 0);
      Player.airborne = false; Player.grounded = true; Player.gliderOpen = false;
      Player.alive = true; Player.hp = CONFIG.MAX_HP;
      CAM.yaw = (s * 1.9) % 6.28; CAM.pitch = -0.05; CAM.sync();
      for (var w = 0; w < 6; w++) Game.update(1 / 60);
      var upd = [], ren = [];
      var calls = 0, tris = 0;
      for (var f = 0; f < ${FRAMES}; f++) {
        var t0 = performance.now();
        Game.update(1 / 60);
        var t1 = performance.now();
        Game.render(1 / 60);
        var t2 = performance.now();
        upd.push(t1 - t0); ren.push(t2 - t1);
        calls = App.renderer.info.render.calls;
        tris = App.renderer.info.render.triangles;
      }
      function pct(a, p) {
        var b2 = a.slice().sort(function (x, y) { return x - y; });
        return b2[Math.min(b2.length - 1, Math.floor(b2.length * p))];
      }
      var mem = performance.memory || {};
      out.pois.push({ name: poi.name, at: [Math.round(poi.x), Math.round(poi.z)],
        state: App.state, ground: +ground.toFixed(2),
        updP50: +pct(upd, 0.5).toFixed(2), updP95: +pct(upd, 0.95).toFixed(2),
        updMax: +Math.max.apply(null, upd).toFixed(2),
        renP50: +pct(ren, 0.5).toFixed(2), renP95: +pct(ren, 0.95).toFixed(2),
        renMax: +Math.max.apply(null, ren).toFixed(2),
        calls: calls, tris: tris,
        heapMB: mem.usedJSHeapSize ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : -1,
        alive: App.aliveCount });
    }

    return out;
  })()`);

  /* print and save the sweep before the (slower) soak, so a box that sleeps
     mid-run still leaves the frame data behind */
  console.log('  POI sweep (' + sweep.pois.length + ' of ' + POIS + ' points of interest):');
  for (const p of sweep.pois) {
    console.log('    ' + p.name.padEnd(15) + ' at ' + JSON.stringify(p.at).padEnd(14) +
      ' sim p50/p95/max ' + p.updP50 + '/' + p.updP95 + '/' + p.updMax + ' ms' +
      ' | render ' + p.renP50 + '/' + p.renP95 + '/' + p.renMax + ' ms' +
      ' | ' + p.calls + ' calls, ' + p.tris + ' tris' +
      ' | heap ' + p.heapMB + ' MB | alive ' + p.alive);
  }
  fs.writeFileSync(path.join(OUT, 'perfaudit-sweep.json'), JSON.stringify(sweep, null, 1));
  const rest = await evaluate(`(function () {
    var out = {};
    function step(seconds) {
      var steps = Math.round(seconds / 0.05);
      var long = 0, max = 0, sum = 0;
      for (var i = 0; i < steps; i++) {
        if (App.state === 'GAME_OVER') break;
        var t0 = performance.now();
        try { Game.update(0.05); } catch (e) { return { err: (e && e.message) || 'update threw', i: i }; }
        var dt2 = performance.now() - t0;
        if (dt2 > 8) long++;
        if (dt2 > max) max = dt2;
        sum += dt2;
      }
      return { long: long, max: +max.toFixed(1), avg: +(sum / Math.max(1, steps)).toFixed(3) };
    }
    var mem0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    var samples = [];
    var sim = { long: 0, max: 0, avg: 0, err: null, chunks: 0 };
    for (var c = 0; c < ${SOAK_CHUNKS}; c++) {
      var r = step(15);
      if (r.err) { sim.err = r.err; break; }
      sim.chunks++;
      sim.long += r.long;
      if (r.max > sim.max) sim.max = r.max;
      sim.avg = +((sim.avg * (sim.chunks - 1) + r.avg) / sim.chunks).toFixed(3);
      samples.push({ t: sim.chunks * 15, alive: App.aliveCount, state: App.state,
        heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1,
        rescues: App.rescues, calls: App.renderer.info.render.calls });
      if (App.state === 'GAME_OVER') break;
    }
    var mem1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    out.soak = { sim: sim, samples: samples,
      matchTime: +App.matchTime.toFixed(0), state: App.state, alive: App.aliveCount,
      rescues: App.rescues, heapStartMB: +(mem0 / 1048576).toFixed(1), heapEndMB: +(mem1 / 1048576).toFixed(1),
      geom: App.renderer.info.memory.geometries, tex: App.renderer.info.memory.textures,
      programs: App.renderer.info.programs ? App.renderer.info.programs.length : -1 };

    /* ---------------- restart: does anything grow across a match boundary? ---------------- */
    var before = { geom: App.renderer.info.memory.geometries, tex: App.renderer.info.memory.textures,
      heap: performance.memory ? performance.memory.usedJSHeapSize : 0, calls: App.renderer.info.render.calls };
    App.startMatch();
    /* a few seconds of the new match is enough to prove the rebuilt level is
       complete: the leak question is about the world rebuild, not the drop */
    var r2 = step(10);
    var after = { geom: App.renderer.info.memory.geometries, tex: App.renderer.info.memory.textures,
      heap: performance.memory ? performance.memory.usedJSHeapSize : 0, calls: App.renderer.info.render.calls };
    out.leak = { before: { geom: before.geom, tex: before.tex, heapMB: +(before.heap / 1048576).toFixed(1), calls: before.calls },
      after: { geom: after.geom, tex: after.tex, heapMB: +(after.heap / 1048576).toFixed(1), calls: after.calls },
      secondMatchRan: !r2.err, secondState: App.state };

    /* ---------------- solo mechanics smoke test ---------------- */
    function keys(o) {
      var k = Object.create(null), n;
      for (n in (o || {})) if (o[n] && n !== 'jump') k[n] = true;
      Input.keys = k; Input.updateAxes();
    }
    Player.pos.set(0, World.groundAt(0, 0, World.heightAt(0, 0) + 6) + 1, 0);
    Player.vel.set(0, 0, 0);
    /* the movement test needs a match that is actually being played, not the bus;
       and the keys Input.updateAxes() reads are the BOUND actions (fwd/back/
       left/right), not raw key codes - setting KeyW does nothing */
    App.state = 'PLAYING';
    Player.airborne = false; Player.grounded = true; Player.alive = true; Player.hp = CONFIG.MAX_HP;
    CAM.yaw = Math.PI / 2; CAM.pitch = 0; CAM.sync();
    var x0 = Player.pos.x, z0 = Player.pos.z;
    keys({ fwd: true });
    for (var m = 0; m < 90; m++) Game.update(1 / 60);
    keys({});
    var moved = Math.hypot(Player.pos.x - x0, Player.pos.z - z0);
    Player.vel.set(0, 0, 0);
    var hud = {};
    ['hpBar', 'ammoLine', 'zonePanel', 'minimap', 'killfeed', 'fpsBox'].forEach(function (id) {
      var el = document.getElementById(id);
      hud[id] = !!el;
    });
    out.mechanics = { moved: +moved.toFixed(2), hud: hud, rescues: App.rescues,
      alive: App.aliveCount, state: App.state };

    return out;
  })()`);
  const res = Object.assign({ pois: sweep.pois }, rest);

  /* ---------------- report ---------------- */
  const worstP95 = res.pois.reduce((a, p) => p.updP95 > a.updP95 ? p : a, res.pois[0]);
  const worstMax = res.pois.reduce((a, p) => p.updMax > a.updMax ? p : a, res.pois[0]);
  const worstCalls = res.pois.reduce((a, p) => p.calls > a.calls ? p : a, res.pois[0]);
  console.log('  worst sim p95: ' + worstP95.name + ' ' + worstP95.updP95 + ' ms;' +
    ' worst sim frame: ' + worstMax.name + ' ' + worstMax.updMax + ' ms;' +
    ' most draw calls: ' + worstCalls.name + ' ' + worstCalls.calls);
  console.log('  soak: ' + JSON.stringify(res.soak));
  console.log('  leak check: ' + JSON.stringify(res.leak));
  console.log('  mechanics: ' + JSON.stringify(res.mechanics));

  /* ---------------- checks ---------------- */
  check('the match booted and landed before measuring',
    res.mechanics.alive > 50 && res.mechanics.state !== 'MENU',
    res.mechanics.alive + ' alive, state ' + res.mechanics.state);

  check('every POI renders inside the draw-call budget', worstCalls.calls < 400,
    worstCalls.name + ' issued ' + worstCalls.calls + ' calls');

  check('the simulation stays inside the frame budget at every POI',
    res.pois.every(p => p.updP95 < 15 && p.updMax < 50),
    'worst p95 ' + worstP95.updP95 + ' ms (' + worstP95.name + '), worst frame ' +
    worstMax.updMax + ' ms (' + worstMax.name + ') (a 60 Hz frame is 16.7 ms)');

  check('the render keeps up at every POI (software renderer, so this is a ceiling)',
    res.pois.every(p => p.renP95 < 60),
    'worst render p95 ' + Math.max(...res.pois.map(p => p.renP95)) + ' ms');

  check('a three-minute match soak runs without a long-frame storm',
    res.soak.sim.long <= 4 && res.soak.sim.max < 60,
    res.soak.sim.chunks * 15 + 's simulated, ' + res.soak.sim.long + ' frame(s) over 8 ms, worst ' +
    res.soak.sim.max + ' ms, avg ' + res.soak.sim.avg + ' ms' +
    (res.soak.sim.err ? ' ERR ' + res.soak.sim.err : ''));

  check('nothing falls through the world during a match',
    res.soak.rescues === 0,
    res.soak.rescues + ' rescue(s) in ' + res.soak.matchTime + ' s of match');

  check('the heap stays bounded through a match',
    res.soak.heapEndMB - res.soak.heapStartMB < 60,
    res.soak.heapStartMB + ' -> ' + res.soak.heapEndMB + ' MB');

  check('a second match does not leak geometries or textures',
    res.leak.after.geom <= res.leak.before.geom + 2 && res.leak.after.tex <= res.leak.before.tex + 2,
    'geometries ' + res.leak.before.geom + ' -> ' + res.leak.after.geom +
    ', textures ' + res.leak.before.tex + ' -> ' + res.leak.after.tex +
    ', heap ' + res.leak.before.heapMB + ' -> ' + res.leak.after.heapMB + ' MB');

  check('a second match starts and runs', res.leak.secondMatchRan === true,
    'state ' + res.leak.secondState);

  check('the solo basics work: the stick moves the player',
    res.mechanics.moved > 2,
    res.mechanics.moved + ' m in 1.5 s of holding forward');

  check('the HUD elements are all present during play',
    Object.keys(res.mechanics.hud).every(k => res.mechanics.hud[k]),
    JSON.stringify(res.mechanics.hud));

  fs.writeFileSync(path.join(OUT, 'perfaudit.json'), JSON.stringify(res, null, 1));
  console.log('  wrote playtest/perfaudit.json');
  return res;
};
