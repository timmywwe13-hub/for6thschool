// ADS scenario: aiming works from mouse, trackpad (pointer events), a bare
// auxclick and the keyboard, in both hold and toggle modes, and never sticks.
const press = (type, button) => `(function () {
  Input.locked = true;
  window.dispatchEvent(new PointerEvent('${type}', { button: ${button}, bubbles: true, cancelable: true }));
  return Input.ads;
})()`;

const key = (code, down) => `(function () {
  Input.locked = true;
  window.dispatchEvent(new KeyboardEvent('${down ? 'keydown' : 'keyup'}', { code: '${code}', key: '${code}', bubbles: true }));
  return Input.ads;
})()`;

module.exports = async function ads(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1400);
  await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < 600 && App.state === 'DROP'; i++) Game.update(0.05);
    SETTINGS.adsToggle = false;
    SETTINGS.adsKey = 'KeyV';
    Input.ads = false;
    Player.weapons = [{ id: 'ar', mag: 30 }];
    Player.curSlot = 0;
    return App.state;
  })()`);

  /* ---------------- hold mode ---------------- */
  const down = await evaluate(press('pointerdown', 2));
  const up = await evaluate(press('pointerup', 2));
  /* the mouse fallback is only reachable when pointer events did not arrive for
     the press, so step past the echo guard before testing it */
  await sleep(420);
  const mdown = await evaluate(`(function () {
    Input.ads = false;
    window.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    var on = Input.ads;
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true }));
    var off = Input.ads;
    return on && !off;
  })()`);
  console.log('  pointerdown(2) -> ' + down + ', pointerup(2) -> ' + up + ', mouse fallback ok -> ' + mdown);
  check('a right-button pointerdown engages ADS', down === true, 'ads=' + down);
  check('releasing it drops ADS', up === false, 'ads=' + up);
  check('the mouse fallback still works when no pointer events arrive',
    mdown === true, 'ads=' + mdown);

  /* In toggle mode a duplicated press is visible: the pointer event flips ADS on
     and the mouse echo, if it were handled too, would flip it straight back. */
  const double = await evaluate(`(function () {
    SETTINGS.adsToggle = true;
    Input.ads = false;
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
    var afterReal = Input.ads;
    window.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    var afterEcho = Input.ads;
    window.dispatchEvent(new PointerEvent('pointerup', { button: 2, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true }));
    SETTINGS.adsToggle = false;
    Input.clearAds();
    return { afterReal: afterReal, afterEcho: afterEcho, afterRelease: Input.ads };
  })()`);
  check('the mouse echo of the same press is not handled twice',
    double.afterReal === true && double.afterEcho === true && double.afterRelease === false,
    JSON.stringify(double));

  const aux = await evaluate(`(function () {
    Input.ads = false;
    SETTINGS.adsToggle = false;
    window.dispatchEvent(new MouseEvent('auxclick', { button: 2, bubbles: true }));
    return { during: Input.ads };
  })()`);
  /* the pulse is 320 ms; wait well past it, because a machine running several
     headless browsers at once can delay a page's timers by a few hundred ms and
     this assertion is about the pulse ending, not about it being prompt */
  await sleep(1200);
  const auxAfter = await evaluate(`Input.ads`);
  check('a bare auxclick aims for a moment (trackpad fallback)',
    aux.during === true && auxAfter === false, JSON.stringify(aux) + ' then ' + auxAfter);

  /* ---------------- toggle mode ---------------- */
  const toggle = await evaluate(`(function () {
    SETTINGS.adsToggle = true;
    Input.ads = false;
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
    var on = Input.ads;
    window.dispatchEvent(new PointerEvent('pointerup', { button: 2, bubbles: true }));
    var stillOn = Input.ads;                     // a release must NOT clear it
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
    var off = Input.ads;
    window.dispatchEvent(new PointerEvent('pointerup', { button: 2, bubbles: true }));
    window.dispatchEvent(new MouseEvent('auxclick', { button: 2, bubbles: true }));
    var backOn = Input.ads;
    SETTINGS.adsToggle = false;
    Input.clearAds();
    return { on: on, stillOn: stillOn, off: off, backOn: backOn };
  })()`);
  console.log('  toggle: ' + JSON.stringify(toggle));
  check('toggle mode turns ADS on and keeps it after the release',
    toggle.on === true && toggle.stillOn === true, JSON.stringify(toggle));
  check('a second click turns it off again', toggle.off === false);
  check('an auxclick also toggles', toggle.backOn === true);

  /* ---------------- keyboard aim ---------------- */
  const kd = await evaluate(key('KeyV', true));
  const ku = await evaluate(key('KeyV', false));
  console.log('  V down -> ' + kd + ', V up -> ' + ku);
  check('holding the aim key (V by default) engages ADS', kd === true, 'ads=' + kd);
  check('releasing the aim key drops ADS', ku === false, 'ads=' + ku);

  const rebound = await evaluate(`(function () {
    SETTINGS.adsKey = 'ShiftLeft';
    var vDown = null, shiftDown = null;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', bubbles: true }));
    vDown = Input.ads;
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV', key: 'v', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
    shiftDown = Input.ads;
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
    var after = Input.ads;
    SETTINGS.adsKey = 'KeyV';
    return { vDown: vDown, shiftDown: shiftDown, after: after };
  })()`);
  console.log('  rebound to Shift: ' + JSON.stringify(rebound));
  check('the aim key is rebindable (ShiftLeft aims)', rebound.shiftDown === true &&
    rebound.after === false, JSON.stringify(rebound));

  /* ---------------- never sticks ---------------- */
  const stuck = await evaluate(`(function () {
    Input.locked = true;
    var out = {};
    var arm = function () {
      window.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
      return Input.ads;
    };
    Input.ads = false; arm();
    UI.toggleMap(true); out.afterMapOpen = Input.ads; UI.toggleMap(false);
    arm(); UI.toggleScoreboard(true); out.afterScoreboard = Input.ads; UI.toggleScoreboard(false);
    arm();
    Input.locked = false; Input.clearAds();      // what the lock handler does
    out.afterUnlock = Input.ads;
    Player.alive = true; Player.hp = 100;
    arm();
    Hit.damage(Player, 9999, { weapon: 'probe' });
    out.afterDeath = Input.ads;
    return out;
  })()`);
  console.log('  clearing: ' + JSON.stringify(stuck));
  check('opening the map clears ADS', stuck.afterMapOpen === false);
  check('opening the scoreboard clears ADS', stuck.afterScoreboard === false);
  check('releasing pointer lock clears ADS', stuck.afterUnlock === false);
  check('dying clears ADS', stuck.afterDeath === false);

  /* ---------------- the setting is wired into the menu ---------------- */
  const ui = await evaluate(`(function () {
    var sel = document.querySelector('[data-set="adsKey"]');
    var box = document.querySelector('[data-set="adsToggle"]');
    if (!sel || !box) return { err: 'settings controls missing' };
    sel.value = 'ControlLeft';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    box.checked = true;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    var out = { key: SETTINGS.adsKey, toggle: SETTINGS.adsToggle };
    sel.value = 'KeyV';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    box.checked = false;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    out.restored = SETTINGS.adsKey + '/' + SETTINGS.adsToggle;
    return out;
  })()`);
  console.log('  settings UI: ' + JSON.stringify(ui));
  check('the aim key and toggle are exposed in the settings menu',
    !ui.err && ui.key === 'ControlLeft' && ui.toggle === true, JSON.stringify(ui));
};
