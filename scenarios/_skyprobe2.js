// Throwaway diagnostic: which layer paints the wavy horizontal bands in the sky?
// Renders one frame per candidate layer combination from drop altitude, looking
// up at empty sky, and reads a vertical strip of pixels straight out of the
// drawing buffer so each case can be compared numerically (band amplitude) and
// visually (screenshots).
//
//   $env:CDP_PORT=9441; node cdp-test.js _skyprobe2
const fs = require('fs');
const path = require('path');

module.exports = async function skyprobe2(ctx) {
  const { evaluate, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('  shot ' + name + '.png');
  }

  /* ---------- boot into a match and park the eye in open sky ---------- */
  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(800);
  console.log(await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    if (App.state === 'DROP') for (var i = 0; i < 600 && App.state === 'DROP'; i++) Game.update(0.2);
    Player.vel.set(0, 0, 0);
    Player.alive = true;
    window.__origGameRender = Game.render;
    /* free of the ground, high enough that nothing at all is overhead */
    window.__eye = function () {
      CAM.pos.set(Player.pos.x, CONFIG.DROP_ALTITUDE, Player.pos.z);
      CAM.yaw = 0; CAM.pitch = 0.85; CAM.sync();
    };
    return 'state ' + App.state + ' dropAlt ' + CONFIG.DROP_ALTITUDE +
      ' far ' + App.camera.far + ' fov ' + App.camera.fov +
      ' skyRadius ' + (World.sky ? World.sky.geometry.parameters.radius : null) +
      ' seg ' + (World.sky ? World.sky.geometry.parameters.widthSegments + 'x' +
        World.sky.geometry.parameters.heightSegments : null) +
      ' toneMapping ' + App.renderer.toneMapping +
      ' colorSpace ' + App.renderer.outputColorSpace +
      ' fog ' + (App.scene.fog ? App.scene.fog.near + '..' + App.scene.fog.far : 'none') +
      ' waterTop ' + (World.water ? World.water.geometry.parameters.height : null);
  })()`));

  /* ---------- one reusable strip reader ---------- */
  const STRIP = `window.__strip = function (fx) {
    var gl = App.renderer.getContext();
    var W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    window.__eye();
    Game.render(0.05);
    var out = [];
    var buf = new Uint8Array(4);
    for (var i = 0; i <= 34; i++) {
      var y = Math.floor(H * (0.02 + i * 0.016));
      gl.readPixels(Math.floor(W * fx), y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      out.push([buf[0], buf[1], buf[2]]);
    }
    return { w: W, h: H, px: out };
  };`;
  await evaluate(STRIP);

  const CASES = [
    ['A everything visible', ''],
    ['B water hidden', 'World.water.visible = false;'],
    ['C dome only', `World.group.children.forEach(function (o) { o.visible = (o === World.sky); });`],
    ['D nothing but clear colour', `World.group.children.forEach(function (o) { o.visible = false; });`],
    ['E restored', `World.group.children.forEach(function (o) { o.visible = true; });`]
  ];

  const columns = [0.3, 0.5, 0.7];
  for (const [label, setup] of CASES) {
    const res = await evaluate(`(function () {
      ${setup}
      return { a: window.__strip(0.3), b: window.__strip(0.5), c: window.__strip(0.7) };
    })()`);
    for (const k of ['a', 'b', 'c']) {
      const g = res[k].px.map(p => p[1]);
      let jump = 0, from = 0;
      for (let i = 1; i < g.length; i++) {
        const d = Math.abs(g[i] - g[i - 1]);
        if (d > jump) { jump = d; from = i; }
      }
      console.log('  ' + label + ' @x' + (k === 'a' ? 0.3 : k === 'b' ? 0.5 : 0.7) +
        '  G=' + g.join(','));
      console.log('      biggest 1-row jump ' + jump + ' levels at sample ' + from +
        '   first ' + g[0] + ' last ' + g[g.length - 1] + '  buffer ' + res[k].w + 'x' + res[k].h);
    }
    if (label[0] === 'A' || label[0] === 'C') await shot('_sky-case-' + label[0]);
  }
};
