// Touch scenario: the on-screen controls a phone plays with - the floating
// movement stick, the look drag and every button (fire / aim / jump / reload /
// pick up / crouch / sprint / swap / heals / map / scores / pause) - plus the
// promise that switching the layer off leaves the mouse path exactly as it was.
//
// The harness runs a mouse-only headless browser, so the layer is turned on the
// way the settings select does it: SETTINGS.touch = 'on' + TouchUI.refresh().

/* build a TouchEvent on the game canvas out of [{id,x,y}] points */
const gestures = (type, points) => `(function () {
  var cv = document.getElementById('gameCanvas');
  var pts = ${JSON.stringify(points)};
  var touches = pts.map(function (p) {
    return new Touch({ identifier: p.id, target: cv, clientX: p.x, clientY: p.y,
                       pageX: p.x, pageY: p.y, radiusX: 12, radiusY: 12, force: 1 });
  });
  cv.dispatchEvent(new TouchEvent('${type}', {
    touches: touches, targetTouches: touches, changedTouches: touches,
    bubbles: true, cancelable: true
  }));
  return { mx: +Input.moveX.toFixed(4), mz: +Input.moveZ.toFixed(4),
           yaw: +CAM.yaw.toFixed(4), pitch: +CAM.pitch.toFixed(4),
           live: document.getElementById('touchStickBase').classList.contains('live') };
})()`;

/* press or release one on-screen button */
const button = (id, type) => `(function () {
  var b = document.querySelector('#touchUI [data-touch="${id}"]');
  if (!b) return { err: 'missing button ${id}' };
  b.dispatchEvent(new PointerEvent('${type}', { pointerId: 7, button: 0, isPrimary: true,
    bubbles: true, cancelable: true }));
  return { id: '${id}', held: !!b._held };
})()`;

module.exports = async function touch(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1400);
  await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < 900 && App.state === 'DROP'; i++) Game.update(0.05);
    Player.alive = true; Player.hp = 100; Player.shield = 0;
    Player.stamina = CONFIG.STAMINA_MAX;
    Player.weapons = []; Player.curSlot = 0;
    Input.ads = false; Input.firing = false;
    return App.state;
  })()`);

  /* ---------------- the device is a mouse box: the layer stays off --------- */
  const off = await evaluate(`(function () {
    return { on: TouchUI.on, device: TouchUI.touchDevice(), setting: SETTINGS.touch,
             root: !!document.getElementById('touchUI'),
             cls: document.body.classList.contains('touchControls') };
  })()`);
  console.log('  default on a desktop: ' + JSON.stringify(off));
  check('a mouse-only browser keeps the touch layer off',
    off.on === false && off.cls === false && off.root === false, JSON.stringify(off));

  /* ---------------- switching it on ---------------------------------------- */
  const on = await evaluate(`(function () {
    SETTINGS.touch = 'on';
    TouchUI.refresh();
    var root = document.getElementById('touchUI');
    var btns = root.querySelectorAll('.tbtn');
    var r = btns[0].getBoundingClientRect();
    return { on: TouchUI.on, visible: !root.classList.contains('hidden'),
             cls: document.body.classList.contains('touchControls'),
             buttons: btns.length, w: Math.round(r.width), h: Math.round(r.height),
             stick: !!document.getElementById('touchStickBase'),
             knob: !!document.getElementById('touchStickKnob'),
             quality: SETTINGS.quality,
             parent: root.parentNode.id,
             mapHint: document.getElementById('fullmapHint').textContent,
             pickHint: document.querySelector('#pickupPrompt b').textContent,
             dropHint: document.getElementById('dropHint').textContent };
  })()`);
  console.log('  layer: ' + JSON.stringify(on));
  check('the on-screen layer builds and shows itself',
    on.on && on.visible && on.cls && on.stick && on.knob, JSON.stringify(on));
  check('every control is there', on.buttons === 15, on.buttons + ' buttons');
  check('buttons are thumb sized', on.w >= 30 && on.h >= 20, on.w + 'x' + on.h);
  check('it is mounted over the play field', on.parent === 'app', on.parent);
  check('the phone preset steps the quality down to medium', on.quality === 'med', on.quality);
  check('key prompts are re-worded for fingers',
    on.mapHint.indexOf('TAP') === 0 && on.pickHint === 'TAP' && on.dropHint.indexOf('STICK') === 0,
    on.mapHint + ' / ' + on.pickHint + ' / ' + on.dropHint);

  /* ---------------- the buttons are really hit-testable ------------------- */
  const hits = await evaluate(`(function () {
    var out = { blocked: [] };
    var btns = document.querySelectorAll('#touchUI .tbtn');
    for (var i = 0; i < btns.length; i++) {
      var r = btns[i].getBoundingClientRect();
      var el = document.elementFromPoint(Math.round(r.left + r.width / 2),
                                        Math.round(r.top + r.height / 2));
      if (el !== btns[i]) {
        out.blocked.push(btns[i].getAttribute('data-touch') + ' <- ' +
                         (el ? (el.id || el.className || el.tagName) : 'nothing'));
      }
    }
    /* the HUD weapons chips have to be tappable too (they live in the HUD, whose
       children are pointer-events:none on a desktop) */
    var chip = document.getElementById('slotRow').children[0];
    var cr = chip.getBoundingClientRect();
    var hit = document.elementFromPoint(Math.round(cr.left + cr.width / 2),
                                        Math.round(cr.top + cr.height / 2));
    out.chip = hit ? (hit.className || hit.tagName) : 'nothing';
    out.chipTappable = !!(hit && hit.closest && hit.closest('.slot') === chip);
    return out;
  })()`);
  console.log('  hit test: ' + JSON.stringify(hits));
  check('no button is covered by anything', hits.blocked.length === 0, hits.blocked.join(' | '));
  check('the HUD weapon chips are tappable in touch mode', hits.chipTappable === true, hits.chip);

  /* ---------------- the movement stick ------------------------------------ */
  const forward = await evaluate(gestures('touchstart', [{ id: 1, x: 150, y: 600 }]));
  check('a thumb on the left half takes the stick',
    forward.live === true && forward.mx === 0 && forward.mz === 0, JSON.stringify(forward));
  const push = await evaluate(gestures('touchmove', [{ id: 1, x: 150, y: 560 }]));
  console.log('  stick forward: ' + JSON.stringify(push));
  check('pushing the stick forward moves you forward',
    push.mz > 0.6 && push.mx === 0, JSON.stringify(push));
  const right = await evaluate(gestures('touchmove', [{ id: 1, x: 190, y: 600 }]));
  check('pushing it right sidesteps right', right.mx > 0.6 && right.mz === 0, JSON.stringify(right));
  const edges = await evaluate(`(function () {
    var cv = document.getElementById('gameCanvas');
    var move = function (x, y) {
      var t = new Touch({ identifier: 1, target: cv, clientX: x, clientY: y });
      cv.dispatchEvent(new TouchEvent('touchmove', { touches: [t], targetTouches: [t],
        changedTouches: [t], bubbles: true, cancelable: true }));
      var mx = Input.moveX, mz = Input.moveZ;
      return { mx: +mx.toFixed(4), mz: +mz.toFixed(4),
               mag: +Math.sqrt(mx * mx + mz * mz).toFixed(4) };
    };
    var out = {};
    out.side = move(900, 600);         // straight right, far past the travel radius
    out.diag = move(900, 200);         // diagonal, far past the travel radius
    out.dead = move(151, 599);         // inside the resting dead zone
    return out;
  })()`);
  console.log('  travel + dead zone: ' + JSON.stringify(edges));
  check('a full push saturates the axis at 1',
    edges.side.mx === 1 && edges.side.mz === 0, JSON.stringify(edges.side));
  check('a diagonal push is capped at unit length, never more',
    edges.diag.mag === 1 && edges.diag.mx < 1 && edges.diag.mz < 1, JSON.stringify(edges.diag));
  check('a resting thumb inside the dead zone gives no input',
    edges.dead.mx === 0 && edges.dead.mz === 0, JSON.stringify(edges.dead));

  const released = await evaluate(gestures('touchend', [{ id: 1, x: 900, y: 120 }]));
  check('letting go stops the movement',
    released.mx === 0 && released.mz === 0 && released.live === false, JSON.stringify(released));

  /* ---------------- the look drag ----------------------------------------- */
  const look = await evaluate(`(function () {
    CAM.yaw = 0; CAM.pitch = 0;
    var cv = document.getElementById('gameCanvas');
    var send = function (type, id, x, y) {
      var t = new Touch({ identifier: id, target: cv, clientX: x, clientY: y });
      cv.dispatchEvent(new TouchEvent(type, { touches: [t], targetTouches: [t],
        changedTouches: [t], bubbles: true, cancelable: true }));
    };
    send('touchstart', 2, 900, 400);
    send('touchmove', 2, 960, 370);
    var dragged = { yaw: +CAM.yaw.toFixed(4), pitch: +CAM.pitch.toFixed(4) };
    send('touchmove', 2, 900, 400);
    var back = { yaw: +CAM.yaw.toFixed(6), pitch: +CAM.pitch.toFixed(6) };
    send('touchmove', 2, 900, 4000);                  // far past the pitch clamp
    var clamped = +CAM.pitch.toFixed(4);
    var axes = { mx: Input.moveX, mz: Input.moveZ };
    send('touchend', 2, 900, 4000);
    CAM.yaw = 0; CAM.pitch = 0;
    return { dragged: dragged, back: back, clamped: clamped, axes: axes };
  })()`);
  console.log('  look drag: ' + JSON.stringify(look));
  const gain = 0.0022 * 2.6 * 1.4;                    // sens * LOOK_GAIN * touchSens
  check('dragging right turns the view right',
    Math.abs(look.dragged.yaw - 60 * gain) < 0.001, JSON.stringify(look.dragged));
  check('dragging up looks up',
    Math.abs(look.dragged.pitch - 30 * gain) < 0.001, JSON.stringify(look.dragged));
  check('dragging back to where it started restores the view',
    Math.abs(look.back.yaw) < 1e-6 && Math.abs(look.back.pitch) < 1e-6, JSON.stringify(look.back));
  check('vertical look is clamped', look.clamped === -1.45, look.clamped);
  check('a look drag never moves the player',
    look.axes.mx === 0 && look.axes.mz === 0, JSON.stringify(look.axes));


  /* ---------------- the trigger ------------------------------------------- */
  const fire = await evaluate(`(function () {
    Player.weapons = [{ id: 'ar', mag: 30 }];
    Player.curSlot = 0; Player.nextShotT = 0; Player.reloadT = 0; Player.alive = true;
    var before = Player.shotsFired;
    ${button('fire', 'pointerdown')};
    var shot = { firing: Input.firing, fired: Player.shotsFired - before };
    ${button('fire', 'pointerup')};
    return { shot: shot, after: Input.firing, mag: Player.weapons[0].mag };
  })()`);
  console.log('  fire: ' + JSON.stringify(fire));
  check('the trigger pulls the trigger',
    fire.shot.firing === true && fire.shot.fired === 1, JSON.stringify(fire.shot));
  check('releasing the trigger stops the shooting',
    fire.after === false && fire.mag === 29, JSON.stringify(fire));

  /* ---------------- aim / jump / reload / crouch / sprint ----------------- */
  const combat = await evaluate(`(function () {
    var out = {};
    Player.alive = true; Player.using = null;
    Player.weapons = [{ id: 'ar', mag: 30 }]; Player.curSlot = 0; Player.reloadT = 0;
    Input.ads = false;
    ${button('aim', 'pointerdown')};
    out.aimOn = Input.ads;
    ${button('aim', 'pointerup')};
    ${button('aim', 'pointerdown')};
    out.aimOff = Input.ads;
    ${button('aim', 'pointerup')};
    Input.jumpQueued = false;
    ${button('jump', 'pointerdown')};
    out.jumpQueued = Input.jumpQueued;
    Input.jumpQueued = false;
    Player.weapons[0].mag = 5;
    Player.ammoReserve.medium = 60;
    ${button('reload', 'pointerdown')};
    out.reloading = Player.reloadT > 0;
    Player.reloadT = 0;
    ${button('crouch', 'pointerdown')};
    out.crouchOn = Input.crouch;
    /* the flag has to reach the player, not just sit in Input */
    Player.grounded = true; Player.update(0.02);
    out.crouching = Player.crouching;
    ${button('crouch', 'pointerup')};
    ${button('crouch', 'pointerdown')};
    out.crouchOff = Input.crouch;
    ${button('crouch', 'pointerup')};
    ${button('sprint', 'pointerdown')};
    out.sprintOn = Input.sprint;
    ${button('sprint', 'pointerup')};
    ${button('sprint', 'pointerdown')};
    out.sprintOff = Input.sprint;
    ${button('sprint', 'pointerup')};
    return out;
  })()`);
  console.log('  combat buttons: ' + JSON.stringify(combat));
  check('AIM toggles the sights on and back off',
    combat.aimOn === true && combat.aimOff === false, JSON.stringify(combat));
  check('JUMP queues a jump', combat.jumpQueued === true, combat.jumpQueued);
  check('RELOAD starts a reload', combat.reloading === true, combat.reloading);
  check('CROUCH toggles, and the player really crouches',
    combat.crouchOn === true && combat.crouching === true && combat.crouchOff === false,
    JSON.stringify(combat));
  check('SPRINT toggles', combat.sprintOn === true && combat.sprintOff === false,
    JSON.stringify(combat));

  /* sprint also has to reach the movement code, which wants a push forward */
  const sprinting = await evaluate(`(function () {
    var cv = document.getElementById('gameCanvas');
    var send = function (type, x, y) {
      var t = new Touch({ identifier: 9, target: cv, clientX: x, clientY: y });
      cv.dispatchEvent(new TouchEvent(type, { touches: [t], targetTouches: [t],
        changedTouches: [t], bubbles: true, cancelable: true }));
    };
    send('touchstart', 150, 600);
    send('touchmove', 150, 552);
    ${button('sprint', 'pointerdown')};
    Player.alive = true; Player.using = null; Input.ads = false;
    Player.stamina = CONFIG.STAMINA_MAX; Player.grounded = true;
    for (var i = 0; i < 6; i++) Game.update(1 / 60);
    var out = { sprinting: Player.sprinting, stamina: Math.round(Player.stamina),
                max: CONFIG.STAMINA_MAX, mz: +Input.moveZ.toFixed(3) };
    ${button('sprint', 'pointerup')};
    ${button('sprint', 'pointerdown')};                 // toggle it back off
    ${button('sprint', 'pointerup')};
    send('touchend', 150, 552);
    return out;
  })()`);
  console.log('  sprinting: ' + JSON.stringify(sprinting));
  check('stick forward plus SPRINT really sprints',
    sprinting.sprinting === true && sprinting.stamina < sprinting.max, JSON.stringify(sprinting));


  /* ---------------- pickup, heals and the weapon swap --------------------- */
  const items = await evaluate(`(function () {
    var out = {};
    /* the pickup button hands over exactly what the crosshair is on. The UI reads
       aimedTarget - the chest under the crosshair if there is one, the ground
       item otherwise - so stub it and check the button follows. */
    var desc = Object.getOwnPropertyDescriptor(Loot, 'aimedTarget');
    var fake = { info: { label: 'PROBE RIFLE' }, item: { kind: 'weapon', w: 'ar' } };
    Object.defineProperty(Loot, 'aimedTarget', { get: function () { return fake; }, configurable: true });
    TouchUI.update();
    out.ready = document.querySelector('#touchUI [data-touch="use"]').classList.contains('ready');
    var seen = null, origTake = Loot.take;
    Loot.take = function (it) { seen = it; return true; };
    ${button('use', 'pointerdown')};
    ${button('use', 'pointerup')};
    Loot.take = origTake;
    Object.defineProperty(Loot, 'aimedTarget', desc);
    TouchUI.update();
    out.tookAimed = seen === fake;
    out.readyCleared = !document.querySelector('#touchUI [data-touch="use"]').classList.contains('ready');

    /* heals: tap to start, tap the same chip again to stop */
    Player.alive = true; Player.using = null; Player.hp = 40; Player.inv.bandage = 2;
    ${button('bandage', 'pointerdown')};
    ${button('bandage', 'pointerup')};
    out.using = Player.using ? Player.using.kind : null;
    ${button('bandage', 'pointerdown')};
    ${button('bandage', 'pointerup')};
    out.cancelled = Player.using === null;
    TouchUI.update();
    out.badge = document.querySelector('#touchUI [data-touch="bandage"]').textContent;

    /* the swap chip walks the weapon slots */
    Player.weapons = [{ id: 'ar', mag: 30 }, { id: 'pistol', mag: 12 }];
    Player.curSlot = 0;
    ${button('swap', 'pointerdown')};
    ${button('swap', 'pointerup')};
    out.slot = Player.curSlot;
    return out;
  })()`);
  console.log('  items: ' + JSON.stringify(items));
  check('the pickup button lights up and takes what you are facing',
    items.ready === true && items.tookAimed === true && items.readyCleared === true,
    JSON.stringify(items));
  check('a heal chip taps on and taps off',
    items.using === 'bandage' && items.cancelled === true, JSON.stringify(items));
  check('the chip carries the count', /2$/.test(items.badge), items.badge);
  check('SWAP cycles the weapon slots', items.slot === 1, items.slot);

  /* ---------------- tapping a weapon chip picks that slot ----------------- */
  const chips = await evaluate(`(function () {
    Player.weapons = [{ id: 'ar', mag: 30 }, { id: 'pistol', mag: 12 }, null, null, null];
    Player.curSlot = 0;
    var row = document.getElementById('slotRow');
    row.children[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    var onSecond = Player.curSlot;
    row.children[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    var onEmpty = Player.curSlot;
    row.children[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { second: onSecond, empty: onEmpty, back: Player.curSlot, slots: row.children.length };
  })()`);
  console.log('  slot chips: ' + JSON.stringify(chips));
  check('tapping a weapon chip picks that slot, an empty one does nothing',
    chips.slots === 5 && chips.second === 1 && chips.empty === 1 && chips.back === 0,
    JSON.stringify(chips));


  /* ---------------- the menus, the map and the trigger safety -------------- */
  const overlays = await evaluate(`(function () {
    var out = {};
    ${button('map', 'pointerdown')};
    ${button('map', 'pointerup')};
    out.mapOpen = UI.mapOpen();
    document.getElementById('fullmapWrap').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    out.mapClosed = UI.mapOpen();
    ${button('scores', 'pointerdown')};
    ${button('scores', 'pointerup')};
    out.scoresOpen = !document.getElementById('scoreboard').classList.contains('hidden');
    ${button('scores', 'pointerdown')};
    ${button('scores', 'pointerup')};
    out.scoresClosed = document.getElementById('scoreboard').classList.contains('hidden');
    /* a finger on the trigger when the match pauses must not stay there */
    Input.firing = true;
    Input.analog.z = 1; Input.updateAxes();
    ${button('pause', 'pointerdown')};
    out.paused = App.paused;
    out.firingAfterPause = Input.firing;
    out.axesAfterPause = Input.moveX + Input.moveZ;
    App.resume();
    return out;
  })()`);
  console.log('  overlays: ' + JSON.stringify(overlays));
  check('MAP opens, and a tap closes it again',
    overlays.mapOpen === true && overlays.mapClosed === false, JSON.stringify(overlays));
  check('SCORES toggles the scoreboard',
    overlays.scoresOpen === true && overlays.scoresClosed === true, JSON.stringify(overlays));
  check('PAUSE pauses, and nothing is left held down',
    overlays.paused === true && overlays.firingAfterPause === false && overlays.axesAfterPause === 0,
    JSON.stringify(overlays));

  const cleanup = await evaluate(`(function () {
    /* dying and a tab-away both have to release the pad */
    Input.firing = true; Input.keys.sprint = true; Input.analog.z = 1; Input.updateAxes();
    Hit.damage(Player, 9999, { weapon: 'probe' });
    var afterDeath = { firing: Input.firing, sprint: Input.sprint, mz: Input.moveZ };
    App.state = 'PLAYING';
    Player.alive = true; Player.hp = 100;
    Input.firing = true; Input.analog.z = 1; Input.updateAxes();
    window.dispatchEvent(new Event('blur'));
    var afterBlur = { firing: Input.firing, sprint: Input.sprint, mz: Input.moveZ };
    Input.keys = Object.create(null); Input.analog.x = 0; Input.analog.z = 0; Input.updateAxes();
    return { afterDeath: afterDeath, afterBlur: afterBlur };
  })()`);
  console.log('  cleanup: ' + JSON.stringify(cleanup));
  check('dying lets go of every button',
    cleanup.afterDeath.firing === false && cleanup.afterDeath.sprint === false &&
    cleanup.afterDeath.mz === 0, JSON.stringify(cleanup.afterDeath));
  check('a tab-away lets go of every button',
    cleanup.afterBlur.firing === false && cleanup.afterBlur.mz === 0,
    JSON.stringify(cleanup.afterBlur));


  /* ---------------- the pointer lock is skipped while the pad is on ------- */
  const lock = await evaluate(`(function () {
    var cv = document.getElementById('gameCanvas');
    var called = 0, orig = cv.requestPointerLock;
    cv.requestPointerLock = function () { called++; return null; };
    Input.requestLock();
    var whileTouch = called;
    TouchUI.setEnabled(false);
    Input.requestLock();
    var whileMouse = called;
    cv.requestPointerLock = orig;
    TouchUI.setEnabled(true);
    return { whileTouch: whileTouch, whileMouse: whileMouse };
  })()`);
  console.log('  pointer lock: ' + JSON.stringify(lock));
  check('no pointer lock is ever asked for on a touch device',
    lock.whileTouch === 0 && lock.whileMouse === 1, JSON.stringify(lock));

  /* ---------------- switching it off restores the desktop ------------------ */
  const desktop = await evaluate(`(function () {
    SETTINGS.touch = 'off';
    TouchUI.refresh();
    var out = {
      on: TouchUI.on, cls: document.body.classList.contains('touchControls'),
      visible: !document.getElementById('touchUI').classList.contains('hidden'),
      mx: Input.moveX, mz: Input.moveZ, sprint: Input.sprint, firing: Input.firing,
      mapHint: document.getElementById('fullmapHint').textContent,
      pickHint: document.querySelector('#pickupPrompt b').textContent
    };
    /* the mouse path is untouched: a right-button press still aims */
    Input.locked = true; Input.ads = false;
    window.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    out.mouseAds = Input.ads;
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true }));
    Input.locked = false; Input.clearAds();
    SETTINGS.touch = 'on';
    TouchUI.refresh();
    return out;
  })()`);
  console.log('  back on the desktop: ' + JSON.stringify(desktop));
  check('the layer hides itself again',
    desktop.on === false && desktop.cls === false && desktop.visible === false,
    JSON.stringify(desktop));
  check('nothing is left stuck when it goes away',
    desktop.mx === 0 && desktop.mz === 0 && desktop.sprint === false &&
    desktop.firing === false, JSON.stringify(desktop));
  check('the key prompts come back',
    desktop.mapHint.indexOf('M / ESC') === 0 && desktop.pickHint === 'E',
    desktop.mapHint + ' / ' + desktop.pickHint);
  check('the mouse path still works with the layer off', desktop.mouseAds === true, desktop.mouseAds);

  /* ---------------- the setting is wired into the menu -------------------- */
  const ui = await evaluate(`(function () {
    var sel = document.querySelector('[data-set="touch"]');
    var sim = document.querySelector('[data-set="touchSens"]');
    if (!sel || !sim) return { err: 'settings controls missing' };
    sel.value = 'off';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    var wentOff = TouchUI.on;
    sel.value = 'on';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sim.value = '2.5';
    sim.dispatchEvent(new Event('input', { bubbles: true }));
    var out = { wentOff: wentOff, wentOn: TouchUI.on, sens: SETTINGS.touchSens,
                shown: document.querySelector('[data-out="touchSens"]').textContent };
    sim.value = '1.4';
    sim.dispatchEvent(new Event('input', { bubbles: true }));
    return out;
  })()`);
  console.log('  settings UI: ' + JSON.stringify(ui));
  check('the touch setting drives the layer from the menu',
    !ui.err && ui.wentOff === false && ui.wentOn === true, JSON.stringify(ui));
  check('the touch look slider is live',
    ui.sens === 2.5 && ui.shown === '2.5\u00d7', JSON.stringify(ui));
};

