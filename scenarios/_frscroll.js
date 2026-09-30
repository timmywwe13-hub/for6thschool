// _frscroll probe: the friends panel has to scroll on a laptop. It emulates a
// laptop-sized window, opens FRIENDS, and then scrolls the two ways a laptop
// actually scrolls - the wheel and the arrow keys - and looks at whether the list
// moved and whether the bottom of the panel is reachable.
//
//   node cdp-test.js _frscroll
//
// The two inputs here are the whole point: the game's global handlers used to
// swallow the wheel and the arrow keys before the page ever saw them, so a list
// with more rows than fit could not be scrolled at all except by dragging the
// (thin, overlay) scrollbar.
const LAPTOP = { width: 1280, height: 660, deviceScaleFactor: 1, mobile: false };
const SHORT = { width: 1024, height: 560, deviceScaleFactor: 1, mobile: false };

module.exports = async function frscroll(ctx) {
  const { evaluate, check, sleep, send } = ctx;

  const until = async (expr, ms) => {
    const deadline = Date.now() + (ms || 9000);
    for (;;) {
      const v = await evaluate(expr);
      if (v) return v;
      if (Date.now() > deadline) return v;
      await sleep(150);
    }
  };
  const measure = `(function () {
    const body = document.querySelector('#friendsScreen .frBody');
    const panel = document.querySelector('#friendsScreen .frPanel');
    const foot = document.querySelector('#friendsScreen .frFoot button');
    const pr = panel.getBoundingClientRect(), fr = foot.getBoundingClientRect();
    return {
      scrollTop: Math.round(body.scrollTop),
      scrollHeight: Math.round(body.scrollHeight),
      clientHeight: Math.round(body.clientHeight),
      canScroll: body.scrollHeight - body.clientHeight > 4,
      panelBottom: Math.round(pr.bottom),
      backBottom: Math.round(fr.bottom),
      viewH: window.innerHeight
    };
  })()`;
  const overTheList = `(function () {
    const r = document.querySelector('#friendsScreen .frBody').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
  const Wheel = async (deltaY) => {
    const at = await evaluate(overTheList);
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y,
      deltaX: 0, deltaY: deltaY, pointerType: 'mouse' });
    await sleep(250);
  };
  const Arrow = async () => {
    const key = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40,
                  nativeVirtualKeyCode: 40 };
    await send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, key));
    await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, key));
    await sleep(140);
  };


  /* a laptop, not the tall window the rest of the suite runs in */
  await send('Emulation.setDeviceMetricsOverride', LAPTOP);
  await until(`document.getElementById('bootLoading').classList.contains('hidden')`, 40000);
  await evaluate(`(function () { App.quitToMenu(); Teams.paint(); return true; })()`);
  await sleep(350);

  /* before anything is touched: is the title screen whole, or does it need to
     scroll - either is fine, as long as PLAY can be reached */
  const menu = await evaluate(`(function () {
    const ss = document.getElementById('startScreen');
    const r = document.getElementById('btnPlay').getBoundingClientRect();
    return { playTop: Math.round(r.top), playBottom: Math.round(r.bottom),
             viewH: window.innerHeight, screenScroll: ss.scrollHeight - ss.clientHeight };
  })()`);
  await evaluate(`(function () {
    const ss = document.getElementById('startScreen');
    ss.scrollTop = ss.scrollHeight;         // reach the bottom the only way there is
    return true;
  })()`);
  await sleep(200);
  const menuBottom = await evaluate(`(function () {
    const r = document.getElementById('btnPlay').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom),
             viewH: window.innerHeight,
             scrollTop: Math.round(document.getElementById('startScreen').scrollTop) };
  })()`);
  check('PLAY on the title screen can be reached in a laptop window',
    menuBottom.top >= 0 && menuBottom.bottom <= menuBottom.viewH,
    JSON.stringify({ first: menu, afterScrolling: menuBottom }));

  await evaluate(`(function () {
    document.getElementById('btnFriends').click();
    Teams.paint();
    return true;
  })()`);
  await sleep(400);
  const opened = await evaluate(measure);
  check('the friends list is taller than its window, so scrolling is what matters',
    opened.canScroll === true, JSON.stringify(opened));
  check('BACK is on screen: the panel never grows past the window',
    opened.backBottom <= opened.viewH && opened.panelBottom <= opened.viewH,
    JSON.stringify(opened));

  await Wheel(600);
  await Wheel(600);
  const wheeled = await evaluate(measure);
  check('the wheel scrolls the friends list',
    wheeled.scrollTop > opened.scrollTop, JSON.stringify(wheeled));

  /* The arrow keys need the list under a click, which is exactly how a laptop user
     arrives here: click a friend, then try to scroll. So click first - on the empty
     state's text, which does nothing - and then press the keys. */
  await evaluate(`(function () {
    document.querySelector('#friendsScreen .frBody').scrollTop = 0;
    return true;
  })()`);
  const at = await evaluate(overTheList);
  const press = { button: 'left', clickCount: 1, pointerType: 'mouse', x: at.x, y: at.y };
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, press));
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, press));
  await sleep(180);
  const focused = await evaluate(`(function () {
    var a = document.activeElement;
    var body = document.querySelector('#friendsScreen .frBody');
    return { on: a ? a.tagName + '.' + (a.className || '') : null, inList: a === body };
  })()`);
  await Arrow();
  await Arrow();
  await Arrow();
  const arrowed = await evaluate(measure);
  check('clicking in the list and pressing the arrow keys scrolls it',
    arrowed.scrollTop > 0, JSON.stringify({ focused: focused, after: arrowed }));

  /* keep wheeling: the whole list has to be reachable, not just the top of it */
  for (let i = 0; i < 8; i++) await Wheel(900);
  const deep = await evaluate(`(function () {
    const body = document.querySelector('#friendsScreen .frBody');
    return { scrollTop: Math.round(body.scrollTop),
             max: Math.round(body.scrollHeight - body.clientHeight) };
  })()`);
  check('wheeling on reaches the very bottom of the list',
    deep.max > 0 && deep.scrollTop >= deep.max - 4, JSON.stringify(deep));

  /* the transport card sits in the other column, so it is reached on its own */
  const copy = await evaluate(`(function () {
    const body = document.querySelector('#friendsScreen .frBody');
    const btn = document.querySelector('#friendsScreen [data-net="copy"]');
    btn.scrollIntoView({ block: 'center' });
    const b = body.getBoundingClientRect(), c = btn.getBoundingClientRect();
    return { copyVisible: c.top >= b.top - 1 && c.bottom <= b.bottom + 1,
             bodyTop: Math.round(b.top), bodyBottom: Math.round(b.bottom),
             copyTop: Math.round(c.top) };
  })()`);
  check('and the CONNECT side of the panel can be scrolled to as well',
    copy.copyVisible === true, JSON.stringify(copy));

  /* a shorter window still has to keep its footer and its scroll */
  await send('Emulation.setDeviceMetricsOverride', SHORT);
  await sleep(400);
  const short = await evaluate(measure);
  check('in a shorter window the panel still fits and still scrolls',
    short.canScroll === true && short.backBottom <= short.viewH,
    JSON.stringify(short));
};
