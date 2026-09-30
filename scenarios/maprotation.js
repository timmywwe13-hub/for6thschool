// Map-rotation scenario: the active island must flip between ISLE ROYALE and
// SURF CITY every CONFIG.MAP_ROTATION_MIN minutes of real wall-clock time, and
// Surf City must build with all six POIs, its lake, its river and the dam.
//
//   node cdp-test.js maprotation
const fs = require('fs');
const path = require('path');

module.exports = async function maprotation(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  shot ' + name + '.png (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
  }

  /* ---- 1. the rotation clock itself (driven with explicit timestamps) ---- */
  const rot = await evaluate(`(function () {
    var MIN = CONFIG.MAP_ROTATION_MIN * 60000;
    return {
      min: CONFIG.MAP_ROTATION_MIN,
      defs: MAP_DEFS.map(function (m) { return m.id + ':' + m.name; }),
      t0: MapRotation.current(0).id,
      t29: MapRotation.current(MIN - 1).id,
      t30: MapRotation.current(MIN).id,
      t59: MapRotation.current(2 * MIN - 1).id,
      t60: MapRotation.current(2 * MIN).id,
      nextAt0: MapRotation.next(0).id,
      cd0: MapRotation.countdown(0),
      cdMid: MapRotation.countdown(MIN / 2)
    };
  })()`);
  check('rotation period is 30 real minutes', rot.min === 30, rot.min);
  check('two maps in rotation', rot.defs.length === 2, rot.defs.join(' | '));
  check('slot 0 = ISLE ROYALE', rot.t0 === 'isle', rot.t0);
  check('slot 0 holds until 30:00', rot.t29 === 'isle', rot.t29);
  check('slot 1 = SURF CITY', rot.t30 === 'surf', rot.t30);
  check('slot 1 holds until 60:00', rot.t59 === 'surf', rot.t59);
  check('rotation wraps at 60:00', rot.t60 === 'isle', rot.t60);
  check('next() predicts the flip', rot.nextAt0 === 'surf', rot.nextAt0);
  check('countdown at slot start = 30:00', rot.cd0 === '30:00', rot.cd0);
  check('countdown mid-slot = 15:00', rot.cdMid === '15:00', rot.cdMid);

  /* ---- 2. the menu carries a live rotation timer ---- */
  const menu = await evaluate(`(function () {
    var MIN = CONFIG.MAP_ROTATION_MIN * 60000;
    var line = document.getElementById('mapRotLine');
    function read() {
      return {
        name: document.getElementById('mapRotName').textContent,
        next: document.getElementById('mapRotNext').textContent,
        word: document.getElementById('mapRotWord').textContent,
        clock: document.getElementById('mapRotClock').textContent,
        tip: document.getElementById('mapRotTip').textContent,
        bar: parseFloat(document.getElementById('mapRotBar').style.width),
        soon: line.classList.contains('soon')
      };
    }
    MapRotation.paint(0);                     // start of a slot
    var at0 = read();
    MapRotation.paint(MIN / 2);               // half way through
    var mid = read();
    /* the rendered bar, not just the style value: transitions could lag it */
    var barEl = document.getElementById('mapRotBar');
    var keepT = barEl.style.transition;
    barEl.style.transition = 'none';
    MapRotation.paint(MIN / 2);
    var barPx = barEl.getBoundingClientRect().width;
    var cardPx = line.getBoundingClientRect().width;
    barEl.style.transition = keepT;
    MapRotation.paint(MIN - 30000);           // 30 s left
    var last30 = read();
    var box = line.getBoundingClientRect();
    return {
      at0: at0, mid: mid, last30: last30, barFrac: barPx / cardPx,
      h: Math.round(box.height), w: Math.round(box.width),
      clockFont: parseFloat(getComputedStyle(document.getElementById('mapRotClock')).fontSize),
      visible: !!(line.offsetWidth && line.offsetHeight),
      onScreen: box.top >= 0 && box.bottom <= window.innerHeight + 1,
      onMenu: document.getElementById('startScreen').contains(line),
      role: line.getAttribute('role')
    };
  })()`);
  console.log('  menu timer: ' + JSON.stringify(menu));
  check('the timer sits on the start menu', menu.onMenu && menu.onScreen && menu.visible,
    'visible ' + menu.visible + ', on screen ' + menu.onScreen);
  check('the timer names the live map', menu.at0.name === 'ISLE ROYALE', menu.at0.name);
  check('the timer names the map it flips to', menu.at0.next === 'SURF CITY', menu.at0.next);
  check('the timer reads 30:00 at the start of a slot', menu.at0.clock === '30:00', menu.at0.clock);
  check('the timer counts down as the slot runs', menu.mid.clock === '15:00', menu.mid.clock);
  check('the progress bar tracks the slot',
    Math.abs(menu.at0.bar) < 0.01 && Math.abs(menu.mid.bar - 50) < 0.5,
    menu.at0.bar + '% -> ' + menu.mid.bar + '%');
  check('the bar you see matches the countdown',
    Math.abs(menu.barFrac - 0.5) < 0.02,
    Math.round(menu.barFrac * 1000) / 10 + '% drawn at the half-way mark');
  check('the last minute of a map warns you',
    menu.last30.soon && menu.last30.word === 'SWITCHING TO' && menu.last30.clock === '0:30',
    menu.last30.clock + ' / ' + menu.last30.word);
  check('the timer says how long a map lasts', /every 30 real minutes/.test(menu.at0.tip),
    menu.at0.tip);
  check('the timer is big enough to read',
    menu.clockFont >= 20 && menu.h >= 40 && menu.w >= 320,
    menu.w + 'x' + menu.h + ' px, clock font ' + menu.clockFont + 'px');
  check('the timer is exposed to screen readers', menu.role === 'timer', menu.role);

  /* the menu repaints itself every second - nothing else drives it. Count the
     repaints (the reads above rendered fixed instants with explicit timestamps)
     and watch the wall-clock value move. */
  await evaluate(`(function () {
    MapRotation.__paints = 0;
    MapRotation.__paint0 = MapRotation.paint;
    MapRotation.paint = function (a) {
      MapRotation.__paints++;
      return MapRotation.__paint0.call(MapRotation, a);
    };
    MapRotation.paint();                      // put the card back on the wall clock
    return true;
  })()`);
  const tick1 = await evaluate(`document.getElementById('mapRotClock').textContent`);
  let live = { paints: 0, clock: tick1 };
  /* up to 6 s, in case the main thread is busy: 1 paint above + 2 ticks */
  for (let tries = 0; tries < 12 && live.paints < 3; tries++) {
    await sleep(500);
    live = await evaluate(`({ paints: MapRotation.__paints,
      clock: document.getElementById('mapRotClock').textContent })`);
  }
  await evaluate(`(function () {
    if (MapRotation.__paint0) {
      MapRotation.paint = MapRotation.__paint0;
      delete MapRotation.__paint0;
      delete MapRotation.__paints;
    }
    return true;
  })()`);
  const secs = (s) => { const p = s.split(':'); return (+p[0]) * 60 + (+p[1]); };
  check('the menu repaints the countdown every second', live.paints >= 3,
    live.paints + ' repaints seen');
  /* it runs down, or the slot flipped under us and it jumped back to 30:00 */
  check('the countdown moves with the wall clock',
    secs(live.clock) < secs(tick1) || secs(live.clock) >= rot.min * 60 - 5,
    tick1 + ' -> ' + live.clock);
  await shot('maprotation-menu-timer');

  /* ---- 2b. the timer survives a phone screen (no horizontal overflow) ---- */
  const measure = `(function () {
    var line = document.getElementById('mapRotLine');
    var box = line.getBoundingClientRect();
    var clock = document.getElementById('mapRotClock');
    var cbox = clock.getBoundingClientRect();
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      w: Math.round(box.width), h: Math.round(box.height),
      overflows: box.width > window.innerWidth + 1 ||
        line.scrollWidth > line.clientWidth + 1,
      squashed: box.height < cbox.height + 6 ||        // flex must not crush it
        cbox.bottom > box.bottom + 1 || cbox.top < box.top - 1,
      clockH: Math.round(cbox.height),
      clockFont: parseFloat(getComputedStyle(clock).fontSize),
      clock: clock.textContent,
      scrollable: document.getElementById('startScreen').scrollHeight >
        document.getElementById('startScreen').clientHeight
    };
  })()`;
  const phones = [
    { width: 844, height: 390, deviceScaleFactor: 2, mobile: true },   // landscape
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }    // portrait
  ];
  const phone = [];
  for (let i = 0; i < phones.length; i++) {
    await send('Emulation.setDeviceMetricsOverride', phones[i]);
    await sleep(350);
    phone.push(await evaluate(measure));
    if (i === 0) await shot('maprotation-menu-timer-phone');
  }
  console.log('  timer on phone screens: ' + JSON.stringify(phone));
  for (let i = 0; i < phone.length; i++) {
    check('the timer fits a ' + phones[i].width + 'px screen',
      !phone[i].overflows && phone[i].w <= phone[i].vw,
      phone[i].w + ' px card in ' + phone[i].vw + ' px viewport');
    check('the clock stays readable at ' + phones[i].width + 'px',
      phone[i].clockFont >= 20 && /^\d+:\d\d$/.test(phone[i].clock),
      phone[i].clockFont + 'px, ' + phone[i].clock);
    check('a short screen cannot squash the timer (' + phones[i].width + 'x' +
      phones[i].height + ')', !phone[i].squashed,
      'card ' + phone[i].h + ' px, clock ' + phone[i].clockH + ' px' +
        (phone[i].scrollable ? ' (menu scrolls, which is fine)' : ''));
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
  await evaluate(`App.onResize(); true;`);

  /* ---- 3. build Surf City directly and inspect the world ---- */
  const surf = await evaluate(`(function () {
    World.build(QUALITY_PRESETS.low, 1234, 'surf');
    var dam = World.colliders.filter(function (c) {
      return Math.abs(c.x - 110) < 1 && Math.abs(c.z + 190) < 1 && c.y1 >= 6 && c.hx >= 50;
    });
    /* walk 24 bearings outward and note where the land ends: a circle would
       give the same radius everywhere, the reference island does not */
    var rays = [];
    for (var i = 0; i < 24; i++) {
      var a = i * Math.PI / 12, shore = 0;
      for (var d = 20; d < 470; d += 4) {
        if (World.heightAt(Math.cos(a) * d, Math.sin(a) * d) > 0.5) shore = d;
      }
      rays.push(shore);
    }
    var city = World.towns.filter(function (t) { return t.city; })[0] || { buildings: [], r: 0 };
    return {
      mapId: World.mapId,
      mapName: World.mapName,
      towns: World.towns.map(function (t) { return t.name; }),
      townYs: World.towns.map(function (t) { return Math.round(t.y * 10) / 10; }),
      lakeH: Math.round(World.heightAt(145, -223) * 10) / 10,
      lagoonH: Math.round(World.heightAt(120, -95) * 10) / 10,
      riverH: Math.round(World.heightAt(94, 44) * 10) / 10,
      creekH: Math.round(World.heightAt(-255, 96) * 10) / 10,
      damH: Math.round(World.heightAt(110, -186) * 10) / 10,
      /* how much of the reference silhouette is dry land, and the same for the
         southern half, plus the share that is underwater with no water body
         there at all ("accidental": land that just sank) */
      dryPct: (function () {
        var dry = 0, tot = 0, dryS = 0, totS = 0, acc = 0, accS = 0;
        for (var z = -460; z < 460; z += 10) {
          for (var x = -460; x < 460; x += 10) {
            var d = Math.sqrt(x * x + z * z);
            if (d > surfShoreR(Math.atan2(z, x)) * 0.94) continue;
            var h = shapedHeight(x, z), cut = surfCarve(x, z);
            tot++; if (h > 0) dry++;
            if (h < 0 && cut < 1) acc++;
            if (z > 0) { totS++; if (h > 0) dryS++; if (h < 0 && cut < 1) accS++; }
          }
        }
        return [Math.round(100 * dry / tot), Math.round(100 * dryS / totS),
                Math.round(1000 * acc / tot) / 10, Math.round(1000 * accS / totS) / 10];
      })(),
      dryRoadPct: (function () {
        var pts = 0, wet = 0;
        var cross = [[80, 90, 40], [59, 343, 40], [110, -190, 60]];
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
              for (var c = 0; c < cross.length; c++) {
                if (Math.hypot(rx - cross[c][0], rz - cross[c][1]) < cross[c][2]) span = true;
              }
              if (span) continue;
              pts++;
              if (World.heightAt(rx, rz) < 0.5) wet++;
            }
          }
        }
        return [pts, wet];
      })(),
      bridges: World.colliders.filter(function (c) {
        return (Math.abs(c.x - 80) < 1 && Math.abs(c.z - 90) < 1 && c.hx >= 22) ||
               (Math.abs(c.x - 59) < 1 && Math.abs(c.z - 343) < 1 && c.hx >= 24);
      }).length,
      damWalls: dam.length,
      cityName: city.name,
      cityBuildings: city.buildings.length,
      cityR: city.r,
      roads: World.roads.length,
      onRoad: Math.round(roadDist(0, 100) * 10) / 10,
      shoreMin: Math.min.apply(null, rays),
      shoreMax: Math.max.apply(null, rays),
      colliders: World.colliders.length,
      lootPoints: World.lootPoints.length,
      spawnNames: World.spawnSpots.filter(function (s) { return s.name; })
        .map(function (s) { return s.name; }),
      mapCanvas: !!World.mapCanvas,
      meshes: World.group ? World.group.children.length : 0
    };
  })()`);
  check('surf build selects surf', surf.mapId === 'surf', surf.mapId);
  check('surf map name', surf.mapName === 'SURF CITY', surf.mapName);
  check('all six POIs present', surf.towns.length === 6 &&
    ['SWEATY SHORES', 'DIVEY DAM', 'BATTLEWOOD BOULEVARD', 'CASHMERE CLIFFS',
     'SUS STUDIOS', 'BREAKER BEACH'].every(function (n) { return surf.towns.indexOf(n) >= 0; }),
    surf.towns.join(', '));
  check('every POI pad above sea level', surf.townYs.every(function (y) { return y > 1.2; }),
    surf.townYs.join(', '));
  check('the big northern lake is underwater', surf.lakeH < -1, 'lake bed ' + surf.lakeH);
  check('the lagoon below the dam holds water', surf.lagoonH < 0, 'lagoon bed ' + surf.lagoonH);
  check('the river cuts through downtown', surf.riverH < 0, 'river bed ' + surf.riverH);
  check('the west coast spring pond holds water', surf.creekH < 0, 'pond bed ' + surf.creekH);
  check('the lake backs onto the dam face', surf.damH < 0, 'water at the dam ' + surf.damH);
  check('the island is dry land inside the reference outline',
    surf.dryPct[0] >= 88, surf.dryPct[0] + '% dry (the lake and river are the rest)');
  check('no accidental water: nothing sank on its own',
    surf.dryPct[2] < 0.5, surf.dryPct[2] + '% of the island');
  check('the southern half is dry land too',
    surf.dryPct[1] >= 85 && surf.dryPct[3] < 0.5,
    surf.dryPct[1] + '% dry, ' + surf.dryPct[3] + '% accidental water');
  check('roads stay on land (except the bridges and the dam crest)',
    surf.dryRoadPct[1] / surf.dryRoadPct[0] < 0.05,
    surf.dryRoadPct[1] + '/' + surf.dryRoadPct[0] + ' samples over water');
  check('both river bridges are in place', surf.bridges === 2, surf.bridges);
  check('dam wall collider (walkable crest)', surf.damWalls === 1, surf.damWalls);
  check('Battlewood Boulevard is a big downtown',
    surf.cityName === 'BATTLEWOOD BOULEVARD' && surf.cityBuildings >= 30 && surf.cityR >= 130,
    surf.cityName + ': ' + surf.cityBuildings + ' buildings, r ' + surf.cityR);
  check('the road network is wired up', surf.roads >= 24 && surf.onRoad < 3,
    surf.roads + ' roads, downtown street ' + surf.onRoad + ' away');
  check('the island is not a circle', surf.shoreMax / surf.shoreMin >= 1.2,
    'radius ' + surf.shoreMin + '..' + surf.shoreMax);
  check('dam + towns registered colliders', surf.colliders > 150, surf.colliders);
  check('loot points rolled', surf.lootPoints > 100, surf.lootPoints);
  check('spawn spots carry all POI names', surf.spawnNames.length >= 6,
    surf.spawnNames.join(', '));
  check('map image rendered', surf.mapCanvas === true);
  check('scene meshes built', surf.meshes > 3, surf.meshes);

  /* dump the pre-rendered top-down map so the POI labels can be eyeballed */
  const mapPng = await evaluate(`(function () {
    return World.mapCanvas.toDataURL('image/png');
  })()`);
  fs.writeFileSync(path.join(OUT, 'maprotation-surfcity-map.png'),
    Buffer.from(mapPng.split(',')[1], 'base64'));
  console.log('  shot maprotation-surfcity-map.png (top-down map render)');

  /* ---- 4. aerial screenshot of the island. The menu fly-around owns the
     camera in MENU state, so pause the loop (it then renders straight from
     App.camera) and drop the fog, which would otherwise wash an island seen
     from 900 m out into flat fog colour. ---- */
  const aerial = await evaluate(`(function () {
    document.getElementById('startScreen').classList.add('hidden');
    App.paused = true;
    App.showScreen(null);
    window.__fog = App.scene.fog || null;
    App.scene.fog = null;
    const cam = App.camera;
    cam.position.set(0, 820, 900);
    cam.rotation.set(-0.79, 0, 0);
    cam.fov = 45;
    cam.updateProjectionMatrix();
    World.syncSky(cam);                 // the pause path does not re-centre the sky dome
    App.renderer.render(App.scene, cam);
    return { y: Math.round(cam.position.y), fov: cam.fov,
             fog: !!App.scene.fog, draws: App.renderer.info.render.calls };
  })()`);
  console.log('  aerial camera: ' + JSON.stringify(aerial));
  check('aerial camera looks down on the island', aerial.y > 700 && aerial.fov === 45,
    'y ' + aerial.y + ', fov ' + aerial.fov);
  await sleep(350);
  await shot('maprotation-surfcity-aerial');
  await evaluate(`(function () {
    App.paused = false;
    App.scene.fog = window.__fog;       // put the match fog back
    document.getElementById('startScreen').classList.remove('hidden');
    return true;
  })()`);

  /* ---- 5. startMatch honours the rotation slot ---- */
  const match = await evaluate(`(function () {
    var keep = MapRotation.current;
    MapRotation.current = function () { return MAP_DEFS[1]; };
    try { App.startMatch(); } finally { MapRotation.current = keep; }
    return {
      state: App.state,
      mapId: World.mapId,
      dropName: document.getElementById('dropMapName').textContent,
      towns: World.towns.length
    };
  })()`);
  check('startMatch drops into the rotated map', match.mapId === 'surf', match.mapId);
  check('match opens on the bus for the rotated map', match.state === 'BUS', match.state);
  check('drop panel shows map name', match.dropName === 'SURF CITY', match.dropName);
  check('match world has all six POIs', match.towns === 6, match.towns);
  await sleep(1200);
  await shot('maprotation-surfcity-drop');

  /* ---- 6. the classic island still builds exactly as before ---- */
  const isle = await evaluate(`(function () {
    World.build(QUALITY_PRESETS.low, 1234, 'isle');
    return {
      mapId: World.mapId,
      towns: World.towns.map(function (t) { return t.name; }),
      mapCanvas: !!World.mapCanvas
    };
  })()`);
  check('isle build still works', isle.mapId === 'isle', isle.mapId);
  /* the traced island carries the nine named sites off the reference art */
  check('isle keeps its own site names', isle.towns.length === 9 &&
    isle.towns.every(function (n) {
      return ['FROSTPINE', 'ICEBOUND KEEP', 'RATTLESNAKE RAVINE', 'SUNSTONE FLATS',
        'LAKESIDE LODGE', 'GREENFIELD', 'REDWOOD RIDGE', 'HARBOR POINT',
        'GULLWING'].indexOf(n) >= 0;
    }), isle.towns.join(', '));
  check('isle map image rendered', isle.mapCanvas === true);

  /* leave the game back on a clean menu for the next scenario */
  await evaluate(`App.quitToMenu(); true;`);
};
