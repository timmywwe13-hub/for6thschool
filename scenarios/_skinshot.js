// _skinshot probe: puts the player on open ground, aims a fixed studio camera
// at him, and measures the character's silhouette in *pixels* - render once
// with the character shown, once with it hidden, then diff the two frame
// buffers. That is the on-screen truth the world-space boxes only approximate,
// and it is what "Demi and Aura are huge next to Freddy" is about.
// Run it with:  node cdp-test.js _skinshot
const fs = require('fs');
const path = require('path');

module.exports = async function skinshot(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  }

  /* ---------- into a live match on open ground ---------- */
  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1600);
  const state = await evaluate(`(function () {
    window.__keepUpdate = Game.update;
    if (App.state === 'BUS') {
      for (var b = 0; b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 220; b++) Bus.update(1 / 60);
      Bus.jump();
    }
    for (var i = 0; i < 900 && App.state === 'DROP'; i++) Game.update(0.05);
    App.state = 'PLAYING'; App.showScreen(null); App.paused = false;
    Player.alive = true; Player.weapons = [null, null, null, null, null]; Player.curSlot = 0;
    Player.vel.set(0, 0, 0);
    return App.state;
  })()`);
  console.log('  match state ' + state);
  await sleep(800);
  /* face north, no gear in hand, standing still - the same pose every time */
  await evaluate(`(function () {
    Player.yaw = 0; CAM.yaw = 0; CAM.pitch = -0.06; CAM.sync();
    Player.vel.set(0, 0, 0);
    return 1;
  })()`);
  await sleep(500);


  /* ---------- the silhouette reader ---------- */
  const PROBE = `(function () {
    window.__sil = function (dist) {
      var ch = App.scene.getObjectByName('playerCharacter');
      var holder = ch && ch.getObjectByName('playerCharacterModel');
      if (!ch || !holder) return { none: true };
      var gl = App.renderer.getContext();
      var W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      var cam = App.camera;
      dist = dist || 4.6;
      var f = new THREE.Vector3(Math.sin(Player.yaw), 0, -Math.cos(Player.yaw));
      cam.position.set(Player.pos.x - f.x * dist, Player.pos.y + 1.30, Player.pos.z - f.z * dist);
      cam.lookAt(Player.pos.x, Player.pos.y + 0.92, Player.pos.z);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();

      /* the character's own world box first, measured with the skinning-aware
         pass the fix uses, so both numbers travel together */
      holder.updateMatrixWorld(true);
      var v = new THREE.Vector3();
      var lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9);
      holder.traverse(function (o) {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        var pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
        if (!pos) return;
        var sk = !!(o.isSkinnedMesh && o.skeleton);
        for (var i = 0; i < pos.count; i += 3) {
          if (sk) o.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
          v.applyMatrix4(o.matrixWorld);
          lo.min(v); hi.max(v);
        }
      });
      var world = { y: +(hi.y - lo.y).toFixed(3), minY: +lo.y.toFixed(3),
                    maxY: +hi.y.toFixed(3), x: +(hi.x - lo.x).toFixed(3) };

      var on = new Uint8Array(W * H * 4), off = new Uint8Array(W * H * 4);
      App.renderer.render(App.scene, cam);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, on);
      ch.visible = false;
      App.renderer.render(App.scene, cam);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, off);
      ch.visible = true;

      var minX = W, maxX = -1, minY = H, maxY = -1, n = 0;
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var i = (y * W + x) * 4;
          var d = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]);
          if (d > 40) {
            n++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (!n) return { none: true, world: world, w: W, h: H };
      return {
        px: maxY - minY + 1, pxW: maxX - minX + 1, count: n, w: W, h: H,
        clipped: (minY === 0 || maxY === H - 1 || minX === 0 || maxX === W - 1),
        world: world
      };
    };
    window.__skinState = function () {
      return { skin: PlayerView.skin(), status: Character.state.status, using: PlayerView.usingModel() };
    };
    return 'ready';
  })()`;
  await evaluate(PROBE);

  const heights = {};
  for (const id of ['freddy', 'demi', 'aura', 'bonnie', 'ghost']) {
    await evaluate(`PlayerView.setSkin('` + id + `'); 'go'`);
    for (let i = 0; i < 250; i++) {
      const st = JSON.parse(await evaluate(`JSON.stringify(window.__skinState())`));
      if (st.skin === id && st.status === 'ready' && st.using) break;
      await sleep(300);
    }
    await sleep(500);
    const r = JSON.parse(await evaluate(`JSON.stringify(window.__sil(4.6))`));
    heights[id] = r.px;
    console.log('  ' + id.padEnd(8) + ' silhouette ' + r.px + ' px tall (' + r.pxW + ' wide, ' +
      r.count + ' px' + (r.clipped ? ', CLIPPED' : '') + ')  world ' + JSON.stringify(r.world) +
      '  frame ' + r.w + 'x' + r.h);
    await shot('_skin-' + id);
  }

  console.log('\n  pixel height next to Freddy:');
  Object.keys(heights).forEach(id => {
    if (heights[id] && heights.freddy) {
      console.log('    ' + id.padEnd(8) + ' ' + (heights[id] / heights.freddy).toFixed(2) + 'x');
    }
  });
};
