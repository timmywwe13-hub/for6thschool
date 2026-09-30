// _menufit probe: the unfolded settings cards have to fit the title screen, and the
// temporary beta note is the thing that gets out of their way. menu.js checks the
// same requirement at the test harness's window size; this one checks it at a
// laptop's, where the note was 20px too many and the last settings rows went under
// the fold. (It was this probe that measured that, on the way to the fix.)
//
//   node cdp-test.js _menufit
const LAPTOP = { width: 1280, height: 660, deviceScaleFactor: 1, mobile: false };
const COUNT = `(function () {
  var host = document.getElementById('startScreen');
  var all = host.querySelectorAll('*');
  var over = 0, worst = 0;
  for (var i = 0; i < all.length; i++) {
    var b = all[i].getBoundingClientRect().bottom;
    if (b > window.innerHeight + 1) over++;
    if (b - window.innerHeight > worst) worst = Math.round(b - window.innerHeight);
  }
  var note = document.querySelector('.betaNote');
  var play = document.getElementById('btnPlay').getBoundingClientRect();
  return { overflowing: over, worstOverhang: worst,
           noteHeight: note ? Math.round(note.getBoundingClientRect().height) : 0,
           screenScrolls: host.scrollHeight > host.clientHeight + 1,
           playTop: Math.round(play.top), playBottom: Math.round(play.bottom),
           metaOpen: host.classList.contains('metaOpen'), viewH: window.innerHeight };
})()`;


module.exports = async function menufit(ctx) {
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

  await send('Emulation.setDeviceMetricsOverride', LAPTOP);
  await until(`document.getElementById('bootLoading').classList.contains('hidden')`, 40000);
  await evaluate(`(function () {
    App.quitToMenu();
    document.querySelector('.modeTile[data-mode=br]').click();
    Teams.paint();
    document.getElementById('btnSettings').click();
    return true;
  })()`);
  await sleep(400);

  const open = await evaluate(COUNT);
  console.log('  settings unfolded: ' + JSON.stringify(open));
  check('the note gets out of the way so the settings cards fit a laptop screen',
    open.metaOpen === true && open.noteHeight === 0 &&
    open.overflowing === 0 && open.screenScrolls === false, JSON.stringify(open));

  await evaluate(`(function () {
    document.getElementById('btnSettings').click();
    return true;
  })()`);
  await sleep(350);
  const folded = await evaluate(COUNT);
  console.log('  settings folded:   ' + JSON.stringify(folded));
  check('folded back up the note is on screen again, with PLAY still reachable',
    folded.metaOpen === false && folded.noteHeight > 0 &&
    folded.playTop >= 0 && folded.playBottom <= folded.viewH, JSON.stringify(folded));
};
