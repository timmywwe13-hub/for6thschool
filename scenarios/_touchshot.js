// Layout probe for the touch controls: emulate a phone in landscape, turn the
// on-screen pad on and photograph it (playtest/_touch-*.png) so the button
// placement and the re-flowed HUD can actually be looked at.
//
//   node cdp-test.js _touchshot
const fs = require('fs');
const path = require('path');

module.exports = async function touchshot(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  shot ' + name + '.png (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
  }

  /* a mid-range phone, landscape */
  const phone = { width: 844, height: 390, deviceScaleFactor: 2, mobile: true };
  const setScreen = async (m) => {
    await send('Emulation.setDeviceMetricsOverride', m);
    await sleep(400);
  };
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await setScreen(phone);

  const detect = await evaluate(`(function () {
    return { points: navigator.maxTouchPoints || 0,
             coarse: window.matchMedia('(pointer: coarse)').matches,
             hoverNone: window.matchMedia('(hover: none)').matches,
             device: TouchUI.touchDevice(), auto: TouchUI.on,
             view: window.innerWidth + 'x' + window.innerHeight };
  })()`);
  console.log('  emulated phone detection: ' + JSON.stringify(detect));

  /* into a live match with gear on, so the HUD shows something real */
  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1600);
  await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < 900 && App.state === 'DROP'; i++) Game.update(0.05);
    App.state = 'PLAYING'; App.showScreen(null); App.paused = false;
    Player.alive = true; Player.hp = 78; Player.shield = 40;
    Player.helmetTier = 2; Player.vestTier = 1;
    Player.weapons = [{ id: 'ar', mag: 25 }, { id: 'sniper', mag: 4 }];
    Player.curSlot = 0;
    Player.inv.bandage = 3; Player.inv.medkit = 1; Player.inv.shield = 2; Player.inv.nade = 2;
    Player.ammoReserve.medium = 90;
    Input.keys = Object.create(null); Input.ads = false; Input.firing = false; Input.updateAxes();
    SETTINGS.touch = 'on'; TouchUI.refresh();
    return { state: App.state, on: TouchUI.on, view: window.innerWidth + 'x' + window.innerHeight };
  })()`);
  await sleep(700);
  await shot('_touch-01-pad');

  /* stick pushed, sprinting, sights up, so the lit states show in the photo */
  await evaluate(`(function () {
    var cv = document.getElementById('gameCanvas');
    var send = function (type, x, y) {
      var t = new Touch({ identifier: 1, target: cv, clientX: x, clientY: y });
      cv.dispatchEvent(new TouchEvent(type, { touches: [t], targetTouches: [t],
        changedTouches: [t], bubbles: true, cancelable: true }));
    };
    send('touchstart', 130, window.innerHeight - 130);
    send('touchmove', 152, window.innerHeight - 178);        // forward and right
    var press = function (name) {
      var b = document.querySelector('#touchUI [data-touch="' + name + '"]');
      b.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 5, button: 0,
        isPrimary: true, bubbles: true, cancelable: true }));
    };
    press('sprint'); press('sprint');                        // on
    press('aim');                                            // sights up
    return true;
  })()`);
  await sleep(900);
  await shot('_touch-02-sprint-ads');

  /* the map has no M key on a phone: it is opened and closed by tapping */
  await evaluate(`(function () {
    var b = document.querySelector('#touchUI [data-touch="map"]');
    b.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 6, button: 0, bubbles: true, cancelable: true }));
    b.dispatchEvent(new PointerEvent('pointerup', { pointerId: 6, button: 0, bubbles: true, cancelable: true }));
    return UI.mapOpen();
  })()`);
  await sleep(500);
  await shot('_touch-03-map');
  const closed = await evaluate(`(function () {
    document.getElementById('fullmapWrap').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return UI.mapOpen();
  })()`);
  check('a tap closes the fullscreen map', closed === false, 'mapOpen=' + closed);

  /* the pause screen, where the touch settings live */
  await evaluate(`App.pause(); 'paused'`);
  await sleep(400);
  await shot('_touch-04-pause');
  const rows = await evaluate(`(function () {
    var host = document.querySelector('[data-host="pause"]');
    return { touch: !!host.querySelector('[data-set="touch"]'),
             sens: !!host.querySelector('[data-set="touchSens"]'),
             open: App.paused };
  })()`);
  console.log('  pause settings rows: ' + JSON.stringify(rows));
  check('the pause screen shows the touch settings',
    rows.touch && rows.sens && rows.open, JSON.stringify(rows));
  await evaluate(`App.resume(); 'resumed'`);

  /* portrait gets the rotate notice (never a hard lock) */
  await setScreen({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  const portrait = await evaluate(`(function () {
    return { cls: document.body.classList.contains('portrait'),
             shown: getComputedStyle(document.getElementById('rotateHint')).display };
  })()`);
  console.log('  portrait notice: ' + JSON.stringify(portrait));
  await shot('_touch-05-portrait');
  check('portrait shows the rotate notice instead of a broken layout',
    portrait.cls === true && portrait.shown === 'flex', JSON.stringify(portrait));

  /* and tapping it lets a determined player play on anyway */
  const dismissed = await evaluate(`(function () {
    document.getElementById('rotateHint').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return getComputedStyle(document.getElementById('rotateHint')).display;
  })()`);
  check('tapping the notice plays on anyway', dismissed === 'none', dismissed);

  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

