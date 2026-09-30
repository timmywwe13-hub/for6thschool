// The live check: the DEPLOY folder booted for real, talking to the relay that is
// actually deployed, with a second player on a raw websocket - the way two
// machines look. It is a manual probe, not part of the suite: it needs a deployed
// relay and a working network, which CI has no business depending on.
//
//   node cdp-test.js _liverelay
//
// Point RELAY at your own relay - the address its landing page prints - and it
// says whether ADD FRIEND really reaches the other player, in both directions,
// through the internet. Everything it needs beyond the relay is the shipped code:
// web/index.html (the folder you drag onto the host) and the wire protocol in
// FRIENDS-NET.md.
const path = require('path');

const RELAY = 'wss://glad-mustang-5022.timmywwe13-hub.deno.net/isle';
const FRIEND = 'DenoFriend';

module.exports = async function liverelay(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const htmlPath = path.resolve(__dirname, '..', 'web', 'index.html')
    .split(String.fromCharCode(92)).join('/');
  const page = 'file:///' + htmlPath;

  async function until(expr, ms) {
    const deadline = Date.now() + (ms || 20000);
    for (;;) {
      let value = null;
      try { value = await evaluate(expr); } catch (e) { value = null; }
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(250);
    }
  }

  /* ---------- the deploy folder, on a device with no relay saved ----------
     The storage is cleared on the page the harness already booted (a file:// page
     shares one origin, so this is the storage the deploy folder will read) and
     then the folder is loaded once - navigating and *then* reloading races the
     reload, which reads as "CONFIG is not defined". */
  await evaluate(`(function () { localStorage.clear(); return true; })()`);
  await send('Page.navigate', { url: page });

  const booted = await until(`(function () {
    try {
      return !!(typeof CONFIG !== 'undefined' && typeof App !== 'undefined' &&
                App.state === 'MENU' &&
                document.getElementById('bootLoading').classList.contains('hidden'));
    } catch (e) { return false; }
  })()`, 40000);
  check('the folder that gets dragged onto the host boots', booted === true);
  if (!booted) return;

  const baked = await evaluate(
    `(typeof CONFIG === 'undefined' || !CONFIG ? null : CONFIG.DEFAULT_RELAY)`);
  check('and it carries the relay the build baked in', baked === RELAY, String(baked));

  const online = await until(`(function () {
    return (Net.kind === 'socket' && Net.socket && Net.socket.readyState === 1)
      ? { relay: Net.relay, room: Net.room, status: Net.status(), me: Net.me() } : null;
  })()`, 30000);
  check('it goes online by itself, with nothing pasted into FRIENDS',
    !!online && online.relay === RELAY && online.room === 'isle' &&
    /^RELAY/.test(String(online.status)), JSON.stringify(online));
  if (!online) {
    /* the relay being gone is the interesting case, so say exactly what the game
       shows a player: which address it dialled, and what it suggests next */
    const why = await evaluate(`(function () {
      return { status: Net.status(), error: Net.lastError, wire: Net.lastWire,
               kind: Net.kind, addresses: Net.addresses().join(' ') };
    })()`);
    check('when the relay is gone the game names the address and says where to look', false,
      JSON.stringify(why));
    return;
  }

  /* ---------- the second device: a raw client in the same room ---------- */
  const other = new WebSocket(RELAY);
  const heard = [];
  other.addEventListener('message', (e) => heard.push(JSON.parse(e.data)));
  await new Promise((resolve, reject) => {
    other.onopen = resolve;
    other.onerror = () => reject(new Error('the raw client could not reach ' + RELAY));
  });
  other.send(JSON.stringify({ t: 'hello', id: FRIEND }));
  other.send(JSON.stringify({ t: 'presence', id: FRIEND, party: [FRIEND],
                              mode: 'solo', state: 'MENU', open: true }));
  const seen = await until(`Net.isLive('${FRIEND}') ? Net.status() : null`, 25000);
  check('a second device on the internet shows up on the roster', !!seen, String(seen));

  /* the link the host is meant to send: in the game, in a box, and it comes back
     to this relay when a friend opens it */
  const link = await evaluate(`(function () {
    Teams.paint();
    const box = document.getElementById('inviteLink');
    return { box: box ? box.value : null, value: Net.inviteLink(),
             dials: Net.normalize(Net.inviteLink()) };
  })()`);
  check('the invite link is in the game, in a box, and dials this relay',
    !!link.box && link.box === link.value && link.dials === RELAY, JSON.stringify(link));

  /* ---------- the bug this whole exercise was about ---------- */
  const asked = await evaluate(`(function () {
    const input = document.getElementById('friendNameInput');
    input.value = '${FRIEND}';
    document.getElementById('friendAddForm').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }));
    return { waiting: Friends.waiting('${FRIEND}'), kind: Net.kind };
  })()`);
  check('ADD FRIEND in the game is reported as sent (not merely kept)',
    asked.waiting === true && asked.kind === 'socket', JSON.stringify(asked));
  let fask = null;
  for (let i = 0; i < 40 && !fask; i++) {
    fask = heard.filter((m) => m.t === 'fask')[0] || null;
    if (!fask) await sleep(250);
  }
  check('and it really arrives at the other player',
    !!fask && fask.to === FRIEND && fask.id === online.me, JSON.stringify(fask));

  /* ---------- and the other way round ---------- */
  other.send(JSON.stringify({ t: 'fask', id: FRIEND, to: online.me }));
  const lane = await until(`(function () {
    const card = document.querySelector('#notifyAsks .notify.ask');
    return card ? card.textContent.replace(/\\s+/g, ' ').trim() : null;
  })()`, 25000);
  check('their request arrives in the game as a card to answer',
    new RegExp(FRIEND.toUpperCase() + ' ADDED YOU').test(String(lane)), String(lane));

  await evaluate(`(function () {
    document.querySelector('#notifyAsks [data-nacc="${FRIEND}"]').click();
    return true;
  })()`);
  const mutual = await until(
    `Friends.mutual('${FRIEND}') ? Friends.inspect().list.map(function (f) { return f.name; }) : null`,
    15000);
  check('ACCEPT makes the friendship mutual in the game',
    Array.isArray(mutual) && mutual.indexOf(FRIEND) >= 0, JSON.stringify(mutual));
  let facc = null;
  for (let i = 0; i < 40 && !facc; i++) {
    facc = heard.filter((m) => m.t === 'facc')[0] || null;
    if (!facc) await sleep(250);
  }
  check('and the other player is told yes', !!facc && facc.to === FRIEND, JSON.stringify(facc));

  try { other.close(); } catch (e) { /* gone */ }
};
