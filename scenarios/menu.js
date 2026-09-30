// Menu scenario: the title screen is a three-tile mode shelf. Battle Royale is
// the mode this build runs, the other two tiles are locked and say so, the
// signed-in line follows the settings panel and PLAY only ever drops the player
// into a mode that exists.
//
//   node cdp-test.js menu
const fs = require('fs');
const path = require('path');

module.exports = async function menu(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  shot ' + name + '.png (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
  }

  /* everything the shelf shows, read straight out of the DOM */
  const SHELF = `(function () {
    var tiles = document.querySelectorAll('.modeTile');
    var out = { tiles: tiles.length, sel: null, locked: [] };
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].classList.contains('sel')) out.sel = tiles[i].getAttribute('data-mode');
      if (tiles[i].classList.contains('locked')) out.locked.push(tiles[i].getAttribute('data-mode'));
    }
    var play = document.getElementById('btnPlay');
    out.playLabel = play ? play.textContent : null;
    out.playVisible = !!play && play.offsetParent !== null;
    out.playLocked = !!play && play.classList.contains('locked');
    out.caption = document.getElementById('modePickName').textContent + ' | ' +
      document.getElementById('modePickSub').textContent;
    out.signed = document.getElementById('signedName').textContent;
    out.footer = document.querySelector('.modeSelect').textContent;
    out.screenUp = !document.getElementById('startScreen').classList.contains('hidden');
    out.settingsOpen = !document.getElementById('modeMeta').classList.contains('hidden');
    out.state = App.state;
    return out;
  })()`;

  const first = await evaluate(SHELF);
  console.log('  shelf: ' + JSON.stringify(first));
  check('the title screen shows three mode tiles', first.tiles === 3, first.tiles + ' tiles');
  check('Battle Royale is the mode selected on boot', first.sel === 'br', first.sel);
  check('Save the World and Creative are marked locked',
    first.locked.length === 2 && first.locked.indexOf('br') === -1, first.locked.join(','));
  check('PLAY is on screen and enabled for Battle Royale',
    first.playVisible && first.playLabel === 'PLAY' && !first.playLocked, first.playLabel);
  check('the caption describes the selected mode', /BATTLE ROYALE/.test(first.caption), first.caption);
  check('the bottom bar says SELECT A GAME MODE', /SELECT A GAME MODE/.test(first.footer), first.footer);
  check('the shelf is over a fresh menu state', first.screenUp && first.state === 'MENU', first.state);
  await shot('14-menu-shelf');

  /* ---------------- a locked tile must not start a match ---------------- */
  const locked = await evaluate(`(function () {
    document.querySelector('.modeTile[data-mode=stw]').click();
    var before = App.state;
    document.getElementById('btnPlay').click();
    var s = ${SHELF};
    s.stateBefore = before;
    return s;
  })()`);
  console.log('  locked tile: ' + JSON.stringify(locked));
  check('clicking a locked tile selects it', locked.sel === 'stw', locked.sel);
  check('a locked mode relabels PLAY as COMING SOON',
    locked.playLabel === 'COMING SOON' && locked.playLocked === true, locked.playLabel);
  check('a locked mode explains itself in the caption',
    /Not in this build/.test(locked.caption), locked.caption);
  check('PLAY on a locked mode does not start a match',
    locked.state === 'MENU' && locked.stateBefore === 'MENU', locked.state + '/' + locked.stateBefore);
  await shot('14-menu-locked');

  const creative = await evaluate(`(function () {
    document.querySelector('.modeTile[data-mode=cre]').click();
    document.getElementById('btnPlay').click();
    return ${SHELF};
  })()`);
  console.log('  creative tile: ' + JSON.stringify(creative));
  check('the Creative tile is locked too',
    creative.sel === 'cre' && creative.playLocked && creative.state === 'MENU', creative.playLabel);

  /* ---------------- the settings panel and the signed-in line ---------------- */
  const settings = await evaluate(`(function () {
    var out = { inputs: document.querySelectorAll('.settingsHost [data-set]').length,
                closedAtBoot: !document.getElementById('modeMeta').classList.contains('hidden') };
    document.getElementById('btnSettings').click();
    var meta = document.getElementById('modeMeta');
    out.opened = !meta.classList.contains('hidden');
    /* the pinned footer would be printed across the unfolded cards */
    out.metaOpenClass = document.getElementById('startScreen').classList.contains('metaOpen');
    out.footOpen = getComputedStyle(document.querySelector('.modeFoot')).position;
    /* ...and the unfolded cards have to fit the screen, otherwise the title
       screen itself grows a scrollbar and the last settings rows hide below
       the fold. Measure the screen overflow and where the bottom bar lands. */
    var host = document.getElementById('startScreen');
    var all = host.querySelectorAll('*');
    var over = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i].getBoundingClientRect().bottom > window.innerHeight + 1) over++;
    }
    out.screenScrolls = host.scrollHeight > host.clientHeight + 1;
    out.overflowing = over;
    var foot = document.querySelector('.modeFoot').getBoundingClientRect();
    var cards = document.getElementById('modeMeta').getBoundingClientRect();
    out.footOnScreen = foot.top >= 0 && foot.bottom <= window.innerHeight + 1;
    out.footBelowCards = foot.top >= cards.bottom - 1;
    var name = document.querySelector('[data-set=name]');
    out.nameField = !!name;
    if (name) {
      name.value = 'Kanga';
      name.dispatchEvent(new Event('input', { bubbles: true }));
    }
    out.signed = document.getElementById('signedName').textContent;
    /* the pause menu carries the same panel; both must stay in sync */
    var both = document.querySelectorAll('[data-set=name]');
    out.panels = both.length;
    both[1].value = 'Skip';
    both[1].dispatchEvent(new Event('input', { bubbles: true }));
    out.signed2 = document.getElementById('signedName').textContent;
    return out;
  })()`);
  console.log('  settings: ' + JSON.stringify(settings));
  check('the settings panel is still in the DOM behind the toggle',
    settings.inputs >= 10, settings.inputs + ' inputs');
  check('settings start folded away', settings.closedAtBoot === false, 'closedAtBoot=' + settings.closedAtBoot);
  check('the SETTINGS button opens the panel', settings.opened === true);
  check('the footer drops out of the pinned bar while the cards are open',
    settings.metaOpenClass === true && settings.footOpen === 'static',
    'metaOpen=' + settings.metaOpenClass + ', position=' + settings.footOpen);
  check('the unfolded cards fit the screen without a scrollbar',
    settings.screenScrolls === false && settings.overflowing === 0,
    'screenScrolls=' + settings.screenScrolls + ', clipped=' + settings.overflowing);
  check('the bottom bar stays below the cards and on screen while they are open',
    settings.footOnScreen === true && settings.footBelowCards === true,
    'onScreen=' + settings.footOnScreen + ', belowCards=' + settings.footBelowCards);
  check('the player name field drives the signed-in line',
    settings.nameField && settings.signed === 'Kanga', settings.signed);
  check('both settings panels stay in sync', settings.panels === 2 && settings.signed2 === 'Skip',
    settings.panels + ' panels, ' + settings.signed2);
  await shot('14-menu-settings');

  /* ---------------- back to Battle Royale: PLAY really starts it ---------------- */
  const started = await evaluate(`(function () {
    var name = document.querySelector('[data-set=name]');
    name.value = 'Kanga';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btnSettings').click();          // fold the panel away again
    var meta = document.getElementById('modeMeta');
    document.querySelector('.modeTile[data-mode=br]').click();
    var shelf = ${SHELF};
    shelf.metaOpenClass = document.getElementById('startScreen').classList.contains('metaOpen');
    shelf.footClosed = getComputedStyle(document.querySelector('.modeFoot')).position;
    document.getElementById('btnPlay').click();
    shelf.stateAfter = App.state;
    shelf.metaHidden = meta.classList.contains('hidden');
    return shelf;
  })()`);
  console.log('  play: ' + JSON.stringify(started));
  check('selecting Battle Royale re-enables PLAY',
    started.sel === 'br' && started.playLabel === 'PLAY' && !started.playLocked, started.playLabel);
  check('PLAY starts a real match', started.stateAfter === 'BUS', started.stateAfter);
  check('folding the panel away pins the footer back on the bottom edge',
    started.metaOpenClass === false && started.footClosed === 'absolute',
    'metaOpen=' + started.metaOpenClass + ', position=' + started.footClosed);
  await sleep(1200);

  /* quitting back must repaint the shelf, name and all */
  const back = await evaluate(`(function () {
    App.quitToMenu();
    return ${SHELF};
  })()`);
  console.log('  back at the menu: ' + JSON.stringify(back));
  check('quitting to the menu shows the shelf again', back.screenUp && back.sel === 'br', back.sel);
  check('the shelf remembers the name after a match', back.signed === 'Kanga', back.signed);
};
