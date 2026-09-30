// _betashot probe: photographs the title screen and the FRIENDS panel, to check the
// temporary beta note actually renders where it should. It is a look-at-it probe,
// not a check of behaviour:
//
//   node cdp-test.js _betashot     ->  playtest/_beta-menu.png, _beta-friends.png
//
// TEMPORARY, like the thing it photographs: when the beta note comes out (the two
// .betaNote elements in index.html and the .betaNote rule in its CSS), take this
// probe out with it.
const fs = require('fs');
const path = require('path');

module.exports = async function betashot(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });
  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  }
  async function until(expr, ms) {
    const deadline = Date.now() + (ms || 9000);
    for (;;) {
      const v = await evaluate(expr);
      if (v) return v;
      if (Date.now() > deadline) return v;
      await sleep(150);
    }
  }
  const notes = `(function () {
    const list = document.querySelectorAll('.betaNote');
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i].getBoundingClientRect();
      out.push({ text: list[i].textContent.replace(/\\s+/g, ' ').trim(),
                 w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
  })()`;

  await until(`document.getElementById('bootLoading').classList.contains('hidden')`, 40000);
  await evaluate(`(function () { App.quitToMenu(); Teams.paint(); return true; })()`);
  await sleep(500);
  const menu = await evaluate(notes);
  check('the beta note is on the title screen, whole and with a size',
    menu.length >= 1 && menu[0].w > 0 && menu[0].h > 0 &&
    /MULTIPLAYER IS IN BETA/.test(menu[0].text) &&
    /OWNER IS TESTING IT OUT/.test(menu[0].text),
    JSON.stringify(menu[0]));
  await shot('_beta-menu');

  await evaluate(`(function () {
    document.getElementById('btnFriends').click();
    Teams.paint();
    return true;
  })()`);
  await sleep(500);
  const panel = await evaluate(`(function () {
    const open = !document.getElementById('friendsScreen').classList.contains('hidden');
    return { open: open, notes: ` + notes + ` };
  })()`);
  check('and the same note sits at the top of the FRIENDS panel',
    panel.open === true && panel.notes.length === 2 && panel.notes[1].w > 0,
    JSON.stringify(panel));
  await shot('_beta-friends');
};
