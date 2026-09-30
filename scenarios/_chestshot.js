// _chestshot probe: the chest model on screen. A studio camera is parked in
// front of one chest and it is photographed closed, cracking open under the
// crosshair, flung open, and shut again - with a pixel diff between the phases
// to prove the lid really moves on screen (not just in the instance matrices).
// The PNGs land in playtest/.
// Run it with:  node cdp-test.js _chestshot
const fs = require('fs');
const path = require('path');

module.exports = async function chestshot(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  }

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1500);
  const setup = await evaluate(`(function () {
    if (App.state === 'BUS') {
      for (var b = 0; b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 220; b++) Bus.update(1 / 60);
      Bus.jump();
    }
    for (var i = 0; i < 900 && App.state === 'DROP'; i++) Game.update(0.05);
    App.state = 'PLAYING';
    App.paused = true;                       // frozen sim: the probe drives the lid
    /* a chest sitting level on open ground, with clear room in front of it */
    var ch = null;
    for (var k = 0; k < Loot.chests.length; k++) {
      var c = Loot.chests[k];
      if (Math.abs(World.groundAt(c.x, c.z, c.y + 0.6) - c.y) > 0.05) continue;
      var clear = true;
      for (var r = 1.2; r <= 3.4; r += 0.6) {
        if (Math.abs(World.heightAt(c.x, c.z + r) - c.y) > 0.6) clear = false;
      }
      if (clear) { ch = c; break; }
    }
    if (!ch) return { err: 'no level chest with open ground in front' };
    window.__ch = ch;
    Player.alive = true; Player.hp = 100;
    Player.vel.set(0, 0, 0);
    Player.pos.set(ch.x, ch.y, ch.z - 1.8);
    /* clear the ground around the studio: the ground loot bobs and spins every
       Loot.update, and that motion would swamp the lid in the pixel diff */
    var junk = [];
    Loot.each(function (it) { if (Math.hypot(it.x - ch.x, it.z - ch.z) < 7) junk.push(it); });
    for (var j = 0; j < junk.length; j++) Loot.consume(junk[j]);
    /* the studio camera: a three-quarter view that holds the whole chest, open
       lid and all */
    window.__cam = function () {
      var cam = App.camera;
      cam.position.set(ch.x + 1.5, ch.y + 1.5, ch.z + 3.1);
      cam.lookAt(ch.x, ch.y + 0.42, ch.z);
      cam.fov = 44;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      World.syncSky(cam);
      App.renderer.render(App.scene, cam);
      return 1;
    };
    /* the frame, reduced to what changed since the last one */
    window.__diff = function (prev) {
      var gl = App.renderer.getContext();
      var W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      var buf = new Uint8Array(W * H * 4);
      App.renderer.render(App.scene, App.camera);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      var keep = Array.prototype.slice.call(buf);
      if (!prev) return { buf: keep, w: W, h: H, changed: -1 };
      var a = prev.buf, n = 0, cx = 0, cy = 0, top = H;
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var i = (y * W + x) * 4;
          var d = Math.abs(buf[i] - a[i]) + Math.abs(buf[i + 1] - a[i + 1]) + Math.abs(buf[i + 2] - a[i + 2]);
          if (d > 40) { n++; cx += x; cy += y; if (y < top) top = y; }
        }
      }
      return { buf: keep, w: W, h: H, changed: n, cx: n ? cx / n : 0, cy: n ? cy / n : 0, top: top };
    };
    /* where a world point lands on screen (the chest's base, to judge "above") */
    window.__screen = function (x, y, z) {
      var v = new THREE.Vector3(x, y, z).project(App.camera);
      return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
    };
    /* nothing aimed at it to start with, and the lid shut */
    ch.want = 0; ch.open = 0; ch.opened = false; ch.peek = 0;
    CAM.pos.set(ch.x + 300, ch.y + 300, ch.z + 300);
    CAM.dir.set(0, 1, 0);   // camera far above, looking up: nothing is aimed;
    for (var f = 0; f < 30; f++) Loot.update(1 / 60);
    window.__cam();
    window.__base = window.__screen(ch.x, ch.y, ch.z);
    window.__prev = null;
    return { err: null, chest: [+ch.x.toFixed(1), +ch.y.toFixed(1), +ch.z.toFixed(1)],
             cleared: junk.length,
             info: Loot.chestInfo, size: window.CHEST_MODEL.size, base: window.__base };
  })()`);
  console.log('  chest shot setup: ' + JSON.stringify(setup));
  check('a level chest with open ground was found', !setup.err, setup.err || JSON.stringify(setup.chest));
  if (setup.err) return;

  /* ---------- the four phases, photographed ---------- */
  async function phase(name, js) {
    const r = await evaluate(js);
    await shot('_chest-' + name);
    return r;
  }

  const closed = await phase('closed', `(function () {
    var ch = window.__ch;
    ch.want = 0; ch.open = 0; ch.peek = 0;
    CAM.pos.set(ch.x + 300, ch.y + 300, ch.z + 300); CAM.dir.set(0, 1, 0);   // camera far above, looking up: nothing is aimed;
    for (var i = 0; i < 30; i++) Loot.update(1 / 60);
    window.__cam();
    window.__prev = window.__diff(null);
    return { open: ch.open, peek: ch.peek };
  })()`);

  /* the crosshair on it: the lid cracks open by itself */
  const peek = await phase('peek', `(function () {
    var ch = window.__ch;
    CAM.pos.set(ch.x, ch.y + 1.2, ch.z - 2.2);
    CAM.dir.set(ch.x - CAM.pos.x, (ch.y + 0.35) - CAM.pos.y, ch.z - CAM.pos.z).normalize();
    for (var j = 0; j < 60; j++) Loot.update(1 / 60);
    var d = window.__diff(window.__prev);
    window.__prev = d;
    window.__cam();
    return { peek: +ch.peek.toFixed(3), changed: d.changed, cy: d.cy, top: d.top };
  })()`);

  /* opened all the way */
  const open = await phase('open', `(function () {
    var ch = window.__ch;
    CAM.pos.set(ch.x + 300, ch.y + 300, ch.z + 300); CAM.dir.set(0, 1, 0);   // camera far above, looking up: nothing is aimed;
    ch.peek = 0; ch.want = 1;
    for (var k = 0; k < 60 && ch.open < 1; k++) Loot.update(1 / 60);
    var d = window.__diff(window.__prev);
    window.__prev = d;
    window.__cam();
    return { open: +ch.open.toFixed(3), changed: d.changed, cy: d.cy, top: d.top };
  })()`);

  /* emptied and shut again */
  const shut = await phase('shut', `(function () {
    var ch = window.__ch;
    ch.want = 0;
    for (var m = 0; m < 60 && ch.open > 0; m++) Loot.update(1 / 60);
    var d = window.__diff(window.__prev);
    window.__cam();
    return { open: +ch.open.toFixed(3), changed: d.changed, cy: d.cy };
  })()`);

  console.log('  phases: ' + JSON.stringify({ closed: closed, peek: peek, open: open, shut: shut }));
  check('the chest starts shut', closed.open === 0 && closed.peek === 0,
    'lid ' + closed.open + ', peek ' + closed.peek);
  check('opening the lid changes the picture',
    open.changed > 400, open.changed + ' pixels differ');
  check('the opened lid rises above the chest',
    open.top < setup.base.y && open.cy < setup.base.y,
    'chest base at y ' + setup.base.y.toFixed(0) + ', lid pixels centre y ' +
    open.cy.toFixed(0) + ', top y ' + open.top);
  check('the crosshair cracks the lid open',
    peek.peek > 0.9 && peek.changed > 40, 'peek ' + peek.peek + ', ' + peek.changed + ' pixels differ');
  check('the lid shuts again when the chest is emptied',
    shut.open === 0 && shut.changed > 400, 'lid ' + shut.open + ', ' + shut.changed + ' pixels differ');
  console.log('  screenshots: playtest/_chest-{closed,peek,open,shut}.png');
};

