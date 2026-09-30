// Two devices, one Supabase channel - the lobby nobody has to run.
//
// The other transport scenarios use a relay this project starts (friendsnet.js,
// friendreq.js) or a plain file host (deployed.js). This is the third: Supabase
// Realtime, where the only thing a host has to do is exist. It drives the shipped
// game in two real browsers against tools/supa-fake.js - a Realtime server for the
// tests, speaking the same Phoenix protocol the real one does - and checks the
// things that only exist on this path:
//
//   * the one-line address (`supabase:<url>|<key>`) dials the project, and the
//     channel is `realtime:<room>`, so a room code still means a lobby;
//   * a friend who opens the invite link is in it with no clicks, because the
//     one-line address rides in ?relay= exactly as a relay URL does;
//   * the game's own message set travels over a broadcast, and the friend on the
//     other page sees what the first one is doing;
//   * presence is what makes a closed page vanish at once - long before the
//     75 s heartbeat window a relay has to fall back on;
//   * two players on one name are told, because the presence list is what shows
//     it (the relay used to be the one that could notice);
//   * a project that refuses the channel is never reported as online.
const http = require('http');
const fs = require('fs');
const path = require('path');
const supaFake = require('../tools/supa-fake.js');

module.exports = async function supanet(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const root = path.resolve(__dirname, '..');

  const fake = await supaFake.start({ port: 0, quiet: true });
  /* the address the game is handed, in the one-line form the FRIENDS box takes */
  const wire = 'supabase:' + fake.url + '|' + fake.key;

  /* ---------- the game on a plain file host ----------
     The shape a Chromebook actually uses: nothing here knows about the protocol,
     which is the point - on Supabase the host only has to serve files. */
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json',
    '.fbx': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8' };
  const files = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root)) { res.writeHead(403); res.end('no'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not here'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
                           'content-length': buf.length, 'cache-control': 'no-cache' });
      res.end(buf);
    });
  });
  const port = await new Promise(resolve =>
    files.listen(0, '0.0.0.0', () => resolve(files.address().port)));
  const base = 'http://127.0.0.1:' + port + '/';
  const link = base + '?room=isle&relay=' + encodeURIComponent(wire);

  /* ---------- helpers ----------
     One CDP connection drives both pages: `session` picks which, and undefined
     means the harness's own page (device one). */
  async function evalOn(session, expr) {
    const r = await send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, session);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page eval failed: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  }
  async function until(session, expr, ms) {
    const deadline = Date.now() + (ms || 15000);
    let last = null;
    for (;;) {
      try { last = await evalOn(session, expr); } catch (e) { last = null; }
      if (last) return last;
      if (Date.now() > deadline) return last;
      await sleep(150);
    }
  }
  const pollA = (expr, ms) => until(undefined, expr, ms);
  const booted = session => until(session, `(function () {
    try {
      return !!(typeof App !== 'undefined' && App.state === 'MENU' &&
                document.getElementById('bootLoading').classList.contains('hidden'));
    } catch (e) { return false; }
  })()`, 40000);

  /* ---------- the fake Realtime server, before anybody joins ---------- */
  const idle = await (await fetch(fake.url + '/')).json();
  check('the Realtime server starts with nothing on any channel',
    Array.isArray(idle.channels) && idle.clients === 0, JSON.stringify(idle));

  /* ---------- device one: a link that carries a Supabase project ---------- */
  await send('Page.navigate', { url: link });
  check('the game boots from a host that only serves files', (await booted(undefined)) === true);
  /* Names are given through `Net.rename`, which is what the Settings field calls:
     these two pages are two tabs, so they share one localStorage, and a direct
     `SETTINGS.name = 'x'` after boot would leave the presence entry this client
     already registered under the profile's name - a fact the clash check below
     would then be measuring by accident. */
  await evaluate(`(function () { const was = SETTINGS.name; SETTINGS.name = 'Alice';
    Net.rename(was); Modes.paint(); return true; })()`);

  const a1 = await pollA(`(function () {
    if (!(Net.kind === 'supa' && Net.sb && Net.sb.joined)) return null;
    return { topic: Net.sb.topic, relay: Net.relay, room: Net.room, status: Net.status(),
             link: Net.inviteLink(), url: Net.supaUrl };
  })()`, 25000);
  check('a supabase: address in the link joins the channel on load, with no click',
    !!a1 && a1.topic === 'realtime:isle' && a1.room === 'isle' &&
    /^supabase:/.test(String(a1.relay)) && a1.url === fake.url, JSON.stringify(a1));
  check('and the status line says which transport is carrying the lobby',
    !!a1 && /^SUPABASE/.test(String(a1.status)), a1 && a1.status);

  /* The deploy path: `node tools/web-build.js` with ISLE_SUPABASE_URL and
     ISLE_SUPABASE_KEY fills the two CONFIG lines in, and the plain game link is
     then online for everybody with nothing pasted and no query string. What that
     comes down to is this - the project has to survive the round trip through
     CONFIG, and has to be in the address list the retry ladder walks. */
  const fromConfig = await evaluate(`(function () {
    CONFIG.SUPABASE_URL = ${JSON.stringify(fake.url)};
    CONFIG.SUPABASE_KEY = ${JSON.stringify(fake.key)};
    const wire = Net.supaDefault();
    const list = Net.addresses();
    CONFIG.SUPABASE_URL = ''; CONFIG.SUPABASE_KEY = '';
    return { wire: wire, inList: list.indexOf(wire) >= 0, list: list.join(' ') };
  })()`);
  check('a build with the project in CONFIG dials it with no link and nothing pasted',
    fromConfig.wire === wire && fromConfig.inList === true, JSON.stringify(fromConfig));
  check('the invite link carries the project, so a friend needs nothing else',
    !!a1 && /[?&]relay=supabase%3A/.test(String(a1.link)) &&
    String(a1.link).indexOf(encodeURIComponent(wire)) > 0, a1 && a1.link);
  /* the paste path: the box takes any lobby address, and this one is a project
     rather than a relay - the same button, the same one-line form */
  await evaluate(`(function () {
    document.getElementById('relayUrl').value = ${JSON.stringify(wire)};
    document.querySelector('[data-net="relay"]').click();
    return true;
  })()`);
  const pasted = await until(undefined, `(function () {
    if (!(Net.kind === 'supa' && Net.sb && Net.sb.joined)) return null;
    return { relay: Net.relay, room: Net.room, note: document.getElementById('netNote').textContent };
  })()`, 20000);
  check('pasting the one-line address into the box and pressing CONNECT RELAY works',
    !!pasted && pasted.relay === wire && pasted.room === 'isle' &&
    /Supabase/i.test(String(pasted.note)), JSON.stringify(pasted));

  /* ---------- device two: the friend opening that link ---------- */
  const created = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const two = { targetId: created.targetId, session: attached.sessionId };
  two.send = (m, p) => send(m, p, two.session);
  two.eval = expr => evalOn(two.session, expr);
  await two.send('Runtime.enable');
  await two.send('Log.enable');
  await two.send('Page.enable');
  await two.send('Page.navigate', { url: a1 ? a1.link : link });
  check('a second device boots the game from the same link', (await booted(two.session)) === true);
  await two.eval(`(function () { const was = SETTINGS.name; SETTINGS.name = 'Bob';
    Net.rename(was); Modes.paint(); return true; })()`);

  const b1 = await until(two.session, `(function () {
    if (!(Net.kind === 'supa' && Net.sb && Net.sb.joined)) return null;
    return { topic: Net.sb.topic, room: Net.room, name: SETTINGS.name };
  })()`, 25000);
  check('and is in the same channel with no click at all',
    !!b1 && b1.topic === 'realtime:isle' && b1.room === 'isle' && b1.name === 'Bob',
    JSON.stringify(b1));

  const sawB = await pollA(`(function () { const r = Net.rec('Bob'); return r ? r.state : null; })()`, 20000);
  check('device one sees device two online', sawB === 'MENU', String(sawB));
  const sawA = await until(two.session, `(function () {
    const r = Net.rec('Alice'); return r ? r.mode : null; })()`, 20000);
  check('and device two sees device one', sawA === 'solo', String(sawA));
  check('the traffic really went over broadcasts, not around them',
    fake.stats.broadcasts >= 6 && fake.stats.joins >= 2 && fake.stats.presence >= 2,
    JSON.stringify(fake.stats));

  /* ---------- the social path, on this transport ---------- */
  await pollA(`(function () { Net.invite('Bob', 'duel'); return true; })()`);
  const invited = await until(two.session, `Net.invites ? Net.lastInvite : null`, 15000);
  check('an invite crosses the wire to the named device', invited === 'Alice:duel', String(invited));
  /* one ask, once: the answer comes back as a boolean, so this is a plain
     evaluation rather than a poll that would ask again on every pass */
  const asked = await evaluate(`(function () { return Friends.ask('Bob').sent ? 'sent' : 'no'; })()`);
  /* a friend request is not a party request: it lands in the notification lane as
     an ADDED YOU card with the two answers on it (see friendreq.js) */
  const askedBack = await until(two.session, `(function () {
    const lane = document.getElementById('notifyAsks');
    const card = lane ? lane.querySelector('.notify.ask') : null;
    if (!card) return null;
    return { card: card.textContent.replace(/\\s+/g, ' ').trim(),
             buttons: card.querySelectorAll('button').length,
             pending: Friends.pending('Alice') };
  })()`, 20000);
  check('a friend request crosses too, and lands as a card to answer',
    asked === 'sent' && !!askedBack && /ALICE ADDED YOU/.test(String(askedBack.card)) &&
    askedBack.buttons === 2 && askedBack.pending === true,
    asked + ' / ' + JSON.stringify(askedBack));

  /* ---------- two players on one name ----------
     The game keys everything on the name, so two people using it cannot see each
     other at all - every message looks like their own echo. A relay was what used
     to notice; here the presence list is, and the check is that the game says so
     rather than looking like a lobby that went quiet. Renaming is what triggers
     it: the presence entry has to be replaced, or the old name lingers. */
  await evaluate(`(function () { SETTINGS.name = 'Bob'; Net.rename('Alice'); return true; })()`);
  const clashB = await until(two.session, `(function () {
    if (!Net.clash) return null;
    Teams.paint();
    const sub = document.getElementById('friendsSub');
    return { clash: Net.clash, panel: sub ? sub.textContent : '' };
  })()`, 15000);
  check('two players on one name are told, from the presence list',
    !!clashB && clashB.clash === 'Bob' && /NAME CLASH/.test(String(clashB.panel)),
    JSON.stringify(clashB));
  const clashA = await pollA(`Net.clash || null`, 15000);
  const stateA = await evaluate(`(function () {
    return { clash: Net.clash, me: SETTINGS.name, joined: !!(Net.sb && Net.sb.joined),
             keys: Net.sb ? Object.keys(Net.sb.keys).length : -1,
             peers: Net.livePeers().join(',') || '(none)', why: Net.lastError };
  })()`);
  check('and the device that renamed is told too', clashA === 'Bob',
    String(clashA) + ' | ' + JSON.stringify(stateA) +
    ' | presence tracks the server saw: ' + fake.stats.presence);

  /* back to two distinct names: the re-track has to replace the entry, or the
     clash would never clear and the roster would stay a name short */
  await evaluate(`(function () { SETTINGS.name = 'Alice'; Net.rename('Bob'); return true; })()`);
  const distinct = await until(two.session, `(function () {
    const r = Net.rec('Alice'); return r ? r.mode : null; })()`, 12000);
  check('renaming back puts the player on the roster again', distinct === 'solo', String(distinct));

  /* ---------- a page that closes is gone at once ----------
     This is the reason presence is on the channel at all: the heartbeat window
     (PEER_TTL, 75 s) is far too slow to be the only way to notice a closed tab,
     and Supabase drops a client's presence the moment its socket dies. */
  const closedAt = Date.now();
  try { await send('Target.closeTarget', { targetId: two.targetId }); } catch (e) { /* gone */ }
  /* the poll has to be the boolean (not a label): a string is always truthy, and
     `until` returns on the first value it gets */
  const gone = await pollA(`!Net.isLive('Bob')`, 8000);
  const took = Date.now() - closedAt;
  check('closing a page takes that player off the roster at once, not after a timeout',
    gone === true && took < 8000,
    (gone ? 'gone' : 'still on the roster') + ' after ' + took + ' ms');

  /* ---------- a project that refuses the channel ----------
     A wrong key, Realtime switched off, a project over its limit: the server
     refuses the join, and the game must not sit there claiming to be online. It
     says why in the panel, marks that address dead and walks the ones it knows -
     here, the project this device joined a moment ago, which is the same ladder a
     relay that moved is handled with. (The refusal itself is transient in
     `lastError` by design: the next line of the ladder overwrites it.) */
  const refuse = await supaFake.start({ port: 0, quiet: true, refuse: 'Invalid API key' });
  const refuseLink = base + '?room=isle&relay=' +
    encodeURIComponent('supabase:' + refuse.url + '|' + refuse.key);
  await send('Page.navigate', { url: refuseLink });
  check('the game boots from a link pointing at a project that refuses',
    (await booted(undefined)) === true);
  const fellBack = await until(undefined, `(function () {
    if (!(Net.kind === 'supa' && Net.sb && Net.sb.joined)) return null;
    return { url: Net.supaUrl, room: Net.room, status: Net.status(), why: Net.lastError };
  })()`, 25000);
  check('a refused channel is left for one that answers, and never reported as online',
    refuse.stats.refusals > 0 && !!fellBack && fellBack.url === fake.url &&
    refuse.snapshot().clients === 0 && /PEER$/.test(String(fellBack.status)),
    'refusals ' + refuse.stats.refusals + ' | ' + JSON.stringify(fellBack));

  /* ---------- put it down ----------
     The pages stop dialling before their lobbies close, so the harness does not
     collect the honest "nothing answered" retries as console errors. */
  try { await evaluate(`(function () { Net.disconnect(); return Net.kind; })()`); } catch (e) { /* gone */ }
  await refuse.close();
  await fake.close();
  await new Promise(resolve => files.close(resolve));
  return { a1, b1, clashA, clashB, fellBack, stats: fake.stats };
};
