// Throwaway: which box makes the title screen taller than the window while the
// settings cards are unfolded, and does anything get clipped?
module.exports = async function layoutProbe(ctx) {
  const { evaluate, sleep } = ctx;
  const PROBE = `(function () {
    var r = function (el) {
      if (!el) return null;
      var b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom),
               h: Math.round(b.height), w: Math.round(b.width) };
    };
    var over = [];
    var all = document.querySelectorAll('#startScreen *');
    for (var i = 0; i < all.length; i++) {
      var b = all[i].getBoundingClientRect();
      if (b.bottom > window.innerHeight + 1 || b.right > window.innerWidth + 1) {
        over.push((all[i].id || all[i].className || all[i].tagName) + ' bottom=' + Math.round(b.bottom));
      }
    }
    var doc = document.documentElement;
    var screenEl = document.getElementById('startScreen');
    var cards = document.querySelectorAll('#modeMeta .card');
    var cardInfo = [];
    for (var c = 0; c < cards.length; c++) {
      cardInfo.push({ h: Math.round(cards[c].getBoundingClientRect().height),
                      scrollH: cards[c].scrollHeight, clientH: cards[c].clientHeight,
                      scrolls: cards[c].scrollHeight > cards[c].clientHeight + 1 });
    }
    return {
      viewport: window.innerWidth + 'x' + window.innerHeight,
      docScroll: doc.scrollHeight, docClient: doc.clientHeight,
      bodyScroll: document.body.scrollHeight,
      scrollable: doc.scrollHeight > doc.clientHeight,
      screenScroll: screenEl.scrollHeight, screenClient: screenEl.clientHeight,
      screenScrolls: screenEl.scrollHeight > screenEl.clientHeight + 1,
      scrollTop: doc.scrollTop,
      overflowApp: getComputedStyle(document.getElementById('app')).overflow,
      overflowScreen: getComputedStyle(document.getElementById('startScreen')).overflow,
      rects: {
        start: r(document.getElementById('startScreen')),
        row: r(document.querySelector('.modeRow')),
        pick: r(document.querySelector('.modePick')),
        meta: r(document.getElementById('modeMeta')),
        foot: r(document.querySelector('.modeFoot')),
        host: r(document.querySelector('#startScreen .settingsHost'))
      },
      footPos: getComputedStyle(document.querySelector('.modeFoot')).position,
      cards: cardInfo,
      overflowing: over.slice(0, 10)
    };
  })()`;

  const closed = await evaluate(PROBE);
  console.log('  closed: ' + JSON.stringify(closed));

  await evaluate(`document.getElementById('btnSettings').click(); 1`);
  await sleep(300);
  const open = await evaluate(PROBE);
  console.log('  open:   ' + JSON.stringify(open));

  /* can the folded card actually be reached by scrolling? */
  const scrolled = await evaluate(
    `(function () { document.documentElement.scrollTop = 9999; window.scrollTo(0, 9999);
       return { top: document.documentElement.scrollTop, win: window.scrollY }; })()`);
  console.log('  scroll: ' + JSON.stringify(scrolled));
};
