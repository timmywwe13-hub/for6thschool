// Sky scenario: the dome has to sit inside the camera's far plane and ride with
// the viewer, so looking up (on foot, at altitude or during the title-screen
// fly-around) paints sky instead of the black clear colour.
//
// A drop can leave the player under a tree canopy with the camera pivot in
// their chest, and then the first thing the view ray meets is the shadowed
// underside of leaves - reading near black. That is cover, not a broken sky,
// so the on-foot probes step the eye straight up until the pixel reads sky and
// report how far they had to go: a dome that really is clipped (the old bug)
// stays black no matter how high the eye rises, so the check still fails.
//
//   node cdp-test.js sky
const fs = require('fs');
const path = require('path');

module.exports = async function sky(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  shot ' + name + '.png (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
  }

  /* the dome is the only mesh in the world group with a sphere this big */
  const DOME = `(function () {
    var dome = null;
    if (!World.group) return null;
    World.group.traverse(function (o) {
      if (o.isMesh && o.geometry && o.geometry.type === 'SphereGeometry' &&
          o.geometry.parameters.radius > 200) dome = o;
    });
    return dome;
  })()`;

  /* One reusable pixel reader, installed in the page: aim from `eye` at
     `pitch`, render a real frame, then read the pixel `band` of the way up the
     frame buffer (0.5 = dead centre), straight after that render. */
  const READER = `window.__readPixel = function (eye, pitch, band) {
    var gl = App.renderer.getContext();
    var W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    CAM.pos.set(Player.pos.x, eye, Player.pos.z);
    CAM.yaw = 0; CAM.pitch = pitch; CAM.sync();
    Game.render(0.05);
    var buf = new Uint8Array(4);
    gl.readPixels(Math.floor(W / 2), Math.floor(H * (band === undefined ? 0.5 : band)), 1, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { r: buf[0], g: buf[1], b: buf[2], w: W, h: H };
  };`;
  /* Sky is blue and clearly brighter than it is red. Both probes use this test:
     a looser "not black" threshold would also be satisfied by the green of a
     grassy ridge (rgb(136,171,92) is brighter than black but is not sky), so the
     pixel has to be blue-dominant before it counts. */
  const IS_SKY = 's.b > 120 && s.b > s.r + 40';

  /* Read a pixel from an open-air view: `band` of the way up the frame, aimed
     at `pitch` from the player's head (or from `eye`, when given), stepping the
     eye up in 4 m steps over any cover until the pixel satisfies `isSky`. */
  async function skyPixel(pitch, band, isSky, eye) {
    return evaluate(`(function () {
      var base = ${eye === undefined ? 'Player.pos.y + CONFIG.CAM_PIVOT' : eye};
      var out = { rise: 0, under: null };
      var s = window.__readPixel(base, ${pitch}, ${band});
      out.r = s.r; out.g = s.g; out.b = s.b; out.w = s.w; out.h = s.h;
      if (!(${isSky})) {
        out.under = { r: s.r, g: s.g, b: s.b };
        for (var rise = 4; rise <= 160; rise += 4) {
          s = window.__readPixel(base + rise, ${pitch}, ${band});
          if (${isSky}) {
            out.rise = rise;
            out.r = s.r; out.g = s.g; out.b = s.b;
            break;
          }
        }
      }
      return out;
    })()`);
  }

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(800);

  const parked = await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    if (App.state === 'DROP') for (var i = 0; i < 600 && App.state === 'DROP'; i++) Game.update(0.2);
    if (App.state !== 'PLAYING') return 'state ' + App.state;
    Bots.update = function () { entityGrid.clear(); BotView.flush(); };
    window.__keepAlive = setInterval(function () {
      Player.hp = CONFIG.MAX_HP; Player.shield = 0;
      var g = World.heightAt(Player.pos.x, Player.pos.z);
      if (Player.pos.y < g) Player.pos.y = g;
    }, 100);
    return 'state ' + App.state;
  })()`);
  console.log('  parked: ' + parked);
  await evaluate(READER);

  /* ---------------- the dome itself ---------------- */
  const dome = await evaluate(`(function () {
    var dome = ${DOME};
    if (!dome) return { found: false };
    return { found: true, radius: dome.geometry.parameters.radius,
             frustumCulled: dome.frustumCulled, far: App.camera.far,
             near: App.camera.near,
             fogged: dome.material.fog === true };
  })()`);
  console.log('  dome: ' + JSON.stringify(dome));
  check('a sky dome exists in the world group', dome.found === true);
  check('the sky dome fits inside the camera far plane', dome.found && dome.radius < dome.far,
    dome.radius + ' m dome vs ' + dome.far + ' m far plane');

  /* ---------------- looking up renders sky, not the clear colour ---------------- */
  await shot('13-sky-up');
  const up = await skyPixel(0.85, 0.5, IS_SKY);   // nose up, well above the horizon
  console.log('  straight up: rgb(' + up.r + ',' + up.g + ',' + up.b + ') at '
    + up.w + 'x' + up.h
    + (up.rise ? ' - the landing was under cover (rgb(' + up.under.r + ',' + up.under.g
        + ',' + up.under.b + ') from the head); clear ' + up.rise + ' m higher'
      : ' from the head'));
  check('looking up paints sky blue, not black',
    up.b > 120 && up.b > up.r + 40, 'rgb(' + up.r + ',' + up.g + ',' + up.b + ')');

  /* altitude: the 330 m drop is where the dome used to slide out of the frustum.
     Nothing is overhead up there, so this one reads without stepping over cover */
  const altitude = await evaluate('CONFIG.DROP_ALTITUDE');
  const high = await skyPixel(0.85, 0.5, IS_SKY, 'CONFIG.DROP_ALTITUDE');
  console.log('  from ' + altitude + ' m up: rgb(' + high.r + ',' + high.g + ',' + high.b + ')');
  check('looking up from drop altitude paints sky blue',
    high.b > 120 && high.b > high.r + 40, 'rgb(' + high.r + ',' + high.g + ',' + high.b + ')');

  /* ---------------- the dome follows whoever is rendering ---------------- */
  const follow = await evaluate(`(function () {
    var dome = ${DOME};
    if (!dome) return { err: 'no dome' };
    CAM.pos.set(Player.pos.x + 40, Player.pos.y + 6, Player.pos.z - 25);
    CAM.pitch = 0.2; CAM.sync();
    Game.render(0.05);
    return { gap: +dome.position.distanceTo(App.camera.position).toFixed(3),
             radius: dome.geometry.parameters.radius };
  })()`);
  console.log('  follow: ' + JSON.stringify(follow));
  check('the dome is recentred on the camera every frame', follow.gap === 0,
    'camera is ' + follow.gap + ' m from the dome centre');

  /* ---------------- the sky is still there above the horizon ---------------- */
  /* Just above the horizon is where a clipped dome and a fog-bound one look the
     same colour, so this one needs the blue test, not a "not black" test: the
     same eye-stepping helper walks over any ridge or canopy in the way. */
  const horizon = await skyPixel(0.0, 0.62, IS_SKY);
  console.log('  just above the horizon: rgb('
    + horizon.r + ',' + horizon.g + ',' + horizon.b + ')'
    + (horizon.rise ? ' - the landing was under cover (rgb(' + horizon.under.r + ','
        + horizon.under.g + ',' + horizon.under.b + ') from the head); clear '
        + horizon.rise + ' m higher' : ' from the head'));
  check('the sky never falls back to black above the horizon',
    horizon.b > 120 && horizon.b > horizon.r + 40,
    'rgb(' + horizon.r + ',' + horizon.g + ',' + horizon.b + ')');

  /* ---------------- the title-screen fly-around keeps the same sky ---------------- */
  await evaluate(`App.quitToMenu(); 'menu'`);
  await sleep(600);
  const menu = await evaluate(`(function () {
    var dome = ${DOME};
    if (!dome) return { err: 'no dome' };
    return { state: App.state,
             gap: +dome.position.distanceTo(App.camera.position).toFixed(3),
             screen: !document.getElementById('startScreen').classList.contains('hidden'),
             domeRadius: dome.geometry.parameters.radius };
  })()`);
  console.log('  menu: ' + JSON.stringify(menu));
  check('the start screen is back up', menu.screen === true && menu.state === 'MENU', menu.state);
  check('the fly-around keeps the dome on the camera', menu.gap === 0,
    'camera is ' + menu.gap + ' m from the dome centre');
  await shot('13-sky-title');

  /* the dome must survive a restart, not pile up a second sphere */
  const rebuilt = await evaluate(`(function () {
    document.getElementById('btnPlay').click();
    var domes = 0;
    World.group.traverse(function (o) {
      if (o.isMesh && o.geometry && o.geometry.type === 'SphereGeometry' &&
          o.geometry.parameters.radius > 200) domes++;
    });
    return { domes: domes, state: App.state };
  })()`);
  console.log('  second match: ' + JSON.stringify(rebuilt));
  check('a new match rebuilds exactly one dome', rebuilt.domes === 1, rebuilt.domes + ' domes');
};
