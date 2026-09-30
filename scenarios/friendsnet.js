// Two devices, one lobby.
//
// This is the cross-machine claim under test, and it runs the shipped code the
// whole way: it starts the real relay (lobby-server.js), serves the real game over
// it, drives two real browser pages through it, and checks the social path -
// presence both ways, the JOINABLE PARTIES roster, JOIN, the party mirrored on
// to the joining machine, invites, the private-message path, party privacy,
// leaving, and the drop announcement. Node's own WebSocket client stands in
// for a third player, which is also how "another room cannot see you" and
// "a message addressed to one player only reaches them" get checked.
const relay = require('../lobby-server.js');

module.exports = async function friendsnet(ctx) {
  const { evaluate, check, sleep, send } = ctx;

  const srv = await relay.start({ port: 0, quiet: true });
  const base = 'http://127.0.0.1:' + srv.port + '/';
  const isle = 'ws://127.0.0.1:' + srv.port + '/isle';

  /* ---------- helpers ----------
     One CDP connection drives several pages: `session` selects which. The
     harness's own `evaluate` is page A, so undefined means "device one". */
  async function evalOn(session, expr) {
    const r = await send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, session);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page eval failed: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  }
  /* poll an expression until it answers truthy, so nothing ever sleeps longer
     than the thing it is waiting for actually takes. The window has to survive
     a starved main thread (two headless browsers on one machine), so it is
     generous: the polls return the moment the answer is there. */
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

  /* ---------- what the server does on its own ---------- */
  const home = await fetch(base);
  const html = await home.text();
  check('the lobby server serves the game itself',
    home.status === 200 && /ISLE ROYALE/.test(html), 'HTTP ' + home.status + ', ' + html.length + ' bytes');
  const vendor = await fetch(base + 'vendor/GLTFLoader.js');
  check('and serves its assets, with the right type',
    vendor.status === 200 && /javascript/.test(vendor.headers.get('content-type') || ''),
    vendor.status + ' ' + vendor.headers.get('content-type'));
  check('a file that is not there is a 404', (await fetch(base + 'nope.glb')).status === 404);
  check('and the game folder cannot be walked out of',
    (await fetch(base + '..%2f..%2fpackage.json')).status === 403);
  const status = await (await fetch(base + 'relay.json')).json();
  check('the relay reports its own state', Array.isArray(status.rooms) && status.clients === 0,
    JSON.stringify(status));

  /* ---------- device one, and device two, both clean ----------
     Both pages boot before either connects, which is what two separate
     machines look like (they do not share a storage area in real life, and
     nothing may auto-dial on the strength of the other's settings). */
  await send('Page.navigate', { url: base });
  check('the game boots when the lobby server is the one serving it', (await booted(undefined)) === true);

  const created = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const two = { targetId: created.targetId, session: attached.sessionId };
  two.send = (m, p) => send(m, p, two.session);
  two.eval = expr => evalOn(two.session, expr);
  await two.send('Runtime.enable');
  await two.send('Log.enable');
  await two.send('Page.enable');
  await two.send('Page.navigate', { url: base });
  check('a second device boots the same game', (await booted(two.session)) === true);

  const names = await evaluate(`(function () { SETTINGS.name = 'Alice'; Modes.paint();
    return document.getElementById('signedName').textContent; })()`);
  const names2 = await two.eval(`(function () { SETTINGS.name = 'Bob'; Modes.paint();
    return document.getElementById('signedName').textContent; })()`);
  check('each device has its own player name', names === 'Alice' && names2 === 'Bob',
    names + ' / ' + names2);


  /* ---------- device one joins the lobby ---------- */
  const a1 = await evaluate(`(function () {
    const ok = Net.connect('isle');
    return { ok: ok, url: Net.roomUrl('isle'), room: Net.room,
             link: Net.inviteLink(), error: Net.lastError };
  })()`);
  check('CONNECT dials the relay that served the page',
    a1.ok === true && /^ws:\/\/127\.0\.0\.1:\d+\/isle$/.test(String(a1.url)) && a1.room === 'isle',
    a1.url + ' (' + a1.error + ')');
  check('and the invite link carries the room code',
    /\?room=isle$/.test(String(a1.link)) && String(a1.link).indexOf('127.0.0.1') > 0, a1.link);
  /* a host that serves the page is not always the host that runs the lobby (the
     game on a static host, the relay somewhere else), and a link that does not
     carry the relay leaves the device that opens it with nothing to dial. The
     check is on the link itself: a foreign relay rides in it, this page's own
     relay does not. */
  const foreign = await evaluate(`(function () {
    const keep = Net.relay, room = Net.room;
    Net.relay = 'wss://relay.example/trios';
    const link = Net.inviteLink();
    Net.relay = keep; Net.room = room;
    return link;
  })()`);
  check('a relay that is not the page host rides in the invite link',
    /[?&]relay=wss%3A%2F%2Frelay\.example%2Ftrios$/.test(String(foreign)), foreign);
  check('the socket really opens',
    (await pollA(`Net.kind === 'socket' && !!Net.socket && Net.socket.readyState === 1`)) === true);

  /* ---------- device two joins the same lobby through the UI ---------- */
  const b1 = await two.eval(`(function () {
    const box = document.getElementById('roomInput');
    box.value = 'isle';
    box.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-net="connect"]').click();
    return { room: Net.room, relay: Net.relay, kind: Net.kind,
             note: document.getElementById('netNote').textContent };
  })()`);
  check('typing the lobby code and pressing CONNECT joins the same lobby',
    b1.room === 'isle' && /\/isle$/.test(String(b1.relay)) && /isl|invite/i.test(String(b1.note)),
    b1.relay);
  check('the second socket opens too',
    (await until(two.session, `Net.kind === 'socket' && !!Net.socket && Net.socket.readyState === 1`)) === true);

  const sawB = await pollA(`(function () { const r = Net.rec('Bob'); return r ? r.state : null; })()`);
  check('device one sees device two online', sawB === 'MENU', String(sawB));
  const sawA = await until(two.session, `(function () {
    const r = Net.rec('Alice'); return r ? r.mode : null; })()`);
  check('and device two sees device one', sawA === 'solo', String(sawA));

  /* ---------- a third player, no browser at all ----------
     Real players re-announce on a heartbeat, so the raw ones do too: presence
     is a pulse, and no check here should hang on one packet winning a race. */
  function rawPlayer(name, mode, party, open) {
    const ws = new WebSocket(isle);
    ws.ready = new Promise(res => ws.addEventListener('open', res));
    ws.say = () => ws.send(JSON.stringify({ t: 'presence', id: name, party: party,
                                            mode: mode, state: 'MENU', open: open }));
    ws.ready.then(() => {
      ws.send(JSON.stringify({ t: 'hello', id: name }));
      ws.say();
      ws.heart = setInterval(ws.say, 2000);
    });
    return ws;
  }
  const mallory = rawPlayer('Mallory', 'duo', ['Mallory'], true);
  const malloryLog = [];
  mallory.addEventListener('message', e => malloryLog.push(JSON.parse(e.data)));
  await mallory.ready;

  /* Mallory is a bare WebSocket client, so its first presence packet can land
     late while two headless browsers fight for the CPU: the step below shows the
     record does arrive AND is complete, and this window has to be wide enough to
     outlast a starved main thread rather than sampling once and blaming the
     netcode. The wait is for the condition the check asserts - a record that
     exists but has not had its `presence` packet yet (mode and state are only
     ever carried by that one) is exactly the partial state a single sample used
     to catch, and fail on. */
  const sawM = await pollA(`(function () {
    const r = Net.rec('Mallory');
    return (r && r.mode === 'duo' && r.state === 'MENU')
      ? { mode: r.mode, seats: (r.party || []).length, state: r.state } : null;
  })()`, 60000);
  /* if a packet ever does go missing, the failure should say what the page
     thought was going on rather than just "null" */
  const netNow = await evaluate(`(function () {
    return { kind: Net.kind, room: Net.room, seen: Net.seen,
             socket: Net.socket ? Net.socket.readyState : -1,
             peers: Net.livePeers().join(',') };
  })()`);
  check('a player on a third machine shows up online',
    !!sawM && sawM.mode === 'duo' && sawM.state === 'MENU',
    JSON.stringify(sawM) + '  with ' + JSON.stringify(netNow));

  /* ---------- the friends panel, driven the way a player drives it ---------- */
  const panel = await evaluate(`(function () {
    document.getElementById('btnFriends').click();
    Teams.paint();
    const rowText = document.getElementById('frPartyList').textContent;
    return { open: !document.getElementById('friendsScreen').classList.contains('hidden'),
             rows: document.querySelectorAll('#frPartyList .frPlayer').length,
             join: document.querySelectorAll('#frPartyList [data-fjoin="Mallory"]').length,
             add: document.querySelectorAll('#frPartyList [data-fadd="Mallory"]').length,
             count: document.getElementById('frJoinCount').textContent,
             onlineTab: document.getElementById('frOnlineTab').textContent,
             badge: document.getElementById('frCount').textContent,
             avatar: document.getElementById('frAvatar').textContent,
             sub: document.getElementById('friendsSub').textContent,
             rowText: rowText };
  })()`);
  check('FRIENDS opens the panel with the roster in it', panel.open === true && panel.rows === 1,
    panel.rows + ' row(s)');
  check('the joinable party row reads like the reference screen',
    panel.join === 1 && /BATTLE ROYALE LOBBY · DUOS/.test(panel.rowText) &&
    /1 \/ 2 seats/.test(panel.rowText) && /OPEN/.test(panel.rowText),
    panel.rowText.replace(/\s+/g, ' ').slice(0, 130));
  check('the header badge, the avatar and the tabs count what is really there',
    panel.badge === '0' && panel.avatar === 'A' && panel.onlineTab === '2' && panel.count === '1',
    'badge ' + panel.badge + ', online ' + panel.onlineTab + ', joinable ' + panel.count);
  check('and a stranger in the lobby can be added from their row', panel.add === 1);


  /* ---------- build the party across the two devices ---------- */
  await evaluate(`(function () { Teams.setMode('duo'); Net.announce(); return Teams.mode; })()`);
  const joinable = await until(two.session,
    `document.querySelectorAll('#frPartyList [data-fjoin="Alice"]').length === 1`);
  check('Alice queueing DUOS makes her party joinable on the other device', joinable === true);

  /* ---------- who is the host ---------- */
  const hostRow = await two.eval(`(function () {
    Teams.paint();
    const btn = document.querySelector('#frPartyList [data-fjoin="Alice"]');
    const row = btn ? btn.closest('.frPlayer') : null;
    const rec = Net.rec('Alice');
    return { text: row ? row.textContent.replace(/\\s+/g, ' ') : '',
             host: rec ? String(rec.host) : '' };
  })()`);
  check('the row that can take you in is marked HOST, and the wire says who it is',
    /HOST/.test(hostRow.text) && hostRow.host === 'Alice', JSON.stringify(hostRow));

  const asked = await two.eval(`(function () {
    Teams.paint();
    document.querySelector('#frPartyList [data-fjoin="Alice"]').click();
    const after = document.querySelector('#frPartyList [data-fjoin="Alice"]');
    return { pending: Teams.pendingJoin, label: after ? after.textContent : 'gone',
             mine: Teams.partyNames().join(',') };
  })()`);
  check('pressing JOIN sends the ask and the button says so',
    asked.pending === 'Alice' && /ASKED/.test(String(asked.label)), JSON.stringify(asked));

  const hostParty = await pollA(`Teams.has('Bob') ? Teams.partyNames().join(',') : null`);
  check('the host takes the friend into the party', hostParty === 'Alice,Bob', String(hostParty));
  const guestParty = await until(two.session,
    `Teams.guestOf === 'Alice' ? Teams.partyNames().join(',') : null`);
  check('the joining device mirrors that party', guestParty === 'Bob,Alice', String(guestParty));

  const hostMark = await evaluate(`(function () {
    Teams.paint();
    return { bar: document.getElementById('partyHost').textContent, mine: Teams.hostName() };
  })()`);
  const guestMark = await two.eval(`(function () {
    Teams.paint();
    const rec = Net.rec('Alice');
    return { bar: document.getElementById('partyHost').textContent,
             host: rec ? String(rec.host) : '' };
  })()`);
  check('the device hosting it says HOST: YOU, and the guest device names the host',
    /HOST: YOU/.test(hostMark.bar) && hostMark.mine === 'Alice' &&
    /HOST: ALICE/.test(guestMark.bar) && guestMark.host === 'Alice',
    JSON.stringify(hostMark) + ' / ' + JSON.stringify(guestMark));

  const planA = await evaluate(`(function () { const p = Teams.matchPlan();
    return { mode: p.mode, mates: p.mates.join(','), size: p.teamSize }; })()`);
  const planB = await two.eval(`(function () { const p = Teams.matchPlan();
    return { mode: p.mode, mates: p.mates.join(','), size: p.teamSize }; })()`);
  check('and both machines build the same squad out of it',
    planA.mode === 'duo' && planB.mode === 'duo' &&
    planA.mates === 'Bob' && planB.mates === 'Alice' && planA.size === 2 && planB.size === 2,
    JSON.stringify(planA) + ' / ' + JSON.stringify(planB));
  const bars = await evaluate(`document.getElementById('partyList').textContent`);
  check('the party bar on device one names the friend from device two', /Bob/.test(bars), bars);

  /* ---------- invites, and what a private message may reach ---------- */
  await evaluate(`(function () { Net.invite('Bob', 'duel'); return true; })()`);
  const invited = await until(two.session, `Net.invites ? Net.lastInvite : null`);
  check('an invite crosses the wire to the named device', invited === 'Alice:duel', String(invited));

  mallory.send(JSON.stringify({ t: 'invite', id: 'Mallory', to: 'Alice', mode: 'squad' }));
  mallory.send(JSON.stringify({ t: 'invite', id: 'Mallory', to: 'Nobody', mode: 'squad' }));
  const addressed = await pollA(`Net.invites ? Net.lastInvite : null`);
  await sleep(500);
  const counter = await evaluate(`Net.invites`);
  check('a message addressed to one player only reaches that player',
    addressed === 'Mallory:squad' && counter === 1, String(addressed) + ', received ' + counter);

  /* and the same the other way round: an invite for somebody else must not
     show up on a third screen - the relay honours `to`, the client obeys it */
  malloryLog.length = 0;
  await evaluate(`(function () { Net.invite('Bob', 'squad'); return true; })()`);
  await sleep(700);
  check('an invite meant for another player never reaches a third machine',
    !malloryLog.some(m => m.t === 'invite'),
    malloryLog.length + ' message(s) reached the third machine');


  /* ---------- a closed party asks instead of letting people in ---------- */
  const locked = await evaluate(`(function () {
    document.querySelector('[data-net="privacy"]').click();
    return { open: Net.partyOpen,
             label: document.querySelector('[data-net="privacy"]').textContent };
  })()`);
  check('the party can be closed to the lobby',
    locked.open === false && /INVITE ONLY/.test(String(locked.label)), JSON.stringify(locked));

  await two.eval(`(function () { Teams.leaveParty(); return Teams.partyNames().join(','); })()`);
  const left = await pollA(`Teams.has('Bob') ? 'still in' : 'gone'`);
  check('walking out of the party takes the guest off the host', left === 'gone', String(left));

  const askAgain = await until(two.session, `(function () {
    Teams.paint();
    const row = document.querySelector('#frPartyList [data-fjoin="Alice"]');
    if (!row) return null;
    if (!/ASK/.test(row.textContent)) return null;
    row.click();
    return { pending: Teams.pendingJoin,
             closed: /INVITE ONLY/.test(document.getElementById('frPartyList').textContent) };
  })()`);
  check('a closed party shows INVITE ONLY and asks rather than joining',
    !!askAgain && askAgain.pending === 'Alice' && askAgain.closed === true, JSON.stringify(askAgain));

  const request = await pollA(`Net.requests.length ? Net.requests[0].name : null`);
  check('and the host gets a request they can answer', request === 'Bob', String(request));
  const waiting = await two.eval(`(function () {
    return { pending: Teams.pendingJoin, in: Teams.has('Alice') }; })()`);
  check('the asking device waits instead of walking in',
    waiting.pending === 'Alice' && waiting.in === false, JSON.stringify(waiting));

  const reqTab = await evaluate(`(function () {
    document.querySelector('[data-frtab="requests"]').click();
    Teams.paint();
    return { shown: !document.getElementById('frReqSec').classList.contains('hidden'),
             accept: document.querySelectorAll('#frReqList [data-facc="Bob"]').length,
             decline: document.querySelectorAll('#frReqList [data-fdec="Bob"]').length,
             text: document.getElementById('frReqList').textContent };
  })()`);
  check('the REQUESTS tab shows the ask with ACCEPT and DECLINE',
    reqTab.shown === true && reqTab.accept === 1 && reqTab.decline === 1,
    String(reqTab.text).replace(/\s+/g, ' ').slice(0, 90));

  const accepted = await evaluate(`(function () {
    document.querySelector('#frReqList [data-facc="Bob"]').click();
    return { party: Teams.partyNames().join(','), reqs: Net.requests.length,
             badge: document.getElementById('frReqTab').textContent };
  })()`);
  check('ACCEPT puts the requester in the party and clears the ask',
    accepted.party === 'Alice,Bob' && accepted.reqs === 0 && accepted.badge === '0',
    JSON.stringify(accepted));
  const rejoined = await until(two.session, `Teams.has('Alice') ? Teams.partyNames().join(',') : null`);
  check('and the guest is told it worked', rejoined === 'Bob,Alice', String(rejoined));

  /* the host leaving takes the party with it - driven through the same handler
     the relay's own `bye` arrives on, so this is the real path, not a stub */
  const dissolved = await two.eval(`(function () {
    Net.handle({ t: 'bye', id: 'Alice' });
    return { party: Teams.partyNames().join(','), host: Teams.guestOf }; })()`);
  check('a host who logs off dissolves the party they were hosting',
    dissolved.party !== 'Bob,Alice' && dissolved.host === '', JSON.stringify(dissolved));


  /* ---------- leaving is announced, so no timeouts are needed ---------- */
  mallory.close();
  const dropped = await pollA(`!Net.isLive('Mallory')`, 6000);
  check('the relay announces a drop at once, with no timeout to wait out', dropped === true);
  const finalStatus = await (await fetch(base + 'relay.json')).json();
  check('and the relay has been carrying real traffic all along',
    finalStatus.clients >= 2 && finalStatus.rooms.some(r => r.room === 'isle' && r.seen > 5),
    JSON.stringify(finalStatus));

  /* ---------- the invite link on the other device ---------- */
  await two.send('Page.navigate', { url: base + '?room=other' });
  check('the second device reloads the game', (await booted(two.session)) === true);
  const other = await until(two.session, `(function () {
    return (Net.room === 'other' && Net.kind === 'socket' && Net.socket.readyState === 1)
      ? { room: Net.room, relay: Net.relay, peers: Net.livePeers().length, name: SETTINGS.name }
      : null;
  })()`, 14000);
  check('an invite link carrying ?room= joins that lobby with no click at all',
    !!other && other.room === 'other' && /\/other$/.test(String(other.relay)), JSON.stringify(other));
  const lost = await pollA(`!Net.isLive('Bob') ? 'gone' : 'still here'`, 8000);
  check('and closing a device announces that too', lost === 'gone', String(lost));
  const here = await evaluate(`Net.livePeers().join(',')`);
  check('a different room is a different lobby',
    !/Recruit/.test(String(here)) && !/Bob/.test(String(here)), 'device one sees [' + here + ']');
  check('the other room is empty on the far side too',
    !!other && other.peers === 0, other && String(other.peers));

  /* ---------- a link that carries the relay itself ----------
     The device that opens the link is served by one host and told to dial
     another (the game on a static host, the lobby running somewhere else), so
     the relay in the link has to win over the page's own host - and it brings
     its room with it. The room in the relay path is deliberately a different one
     from ?room=, so a page that ignored the carried relay cannot pass by luck. */
  await two.send('Page.navigate', { url: base + '?room=trios&relay=' +
    encodeURIComponent('ws://127.0.0.1:' + srv.port + '/squad') });
  check('the second device reloads the game from a link carrying a relay',
    (await booted(two.session)) === true);
  const carried = await until(two.session, `(function () {
    return (Net.kind === 'socket' && !!Net.socket && Net.socket.readyState === 1)
      ? { room: Net.room, relay: Net.relay } : null;
  })()`, 14000);
  check('a relay in the invite link beats the page host, and its room comes with it',
    !!carried && carried.room === 'squad' &&
    carried.relay === 'ws://127.0.0.1:' + srv.port + '/squad', JSON.stringify(carried));

  /* ---------- put it down ---------- */
  try { await send('Target.closeTarget', { targetId: two.targetId }); } catch (e) { /* gone */ }
  /* the page stops dialling before the lobby closes, so the harness does not
     collect the honest "the relay has gone" retries as console errors */
  try { await evaluate(`(function () { Net.disconnect(); return Net.kind; })()`); } catch (e) { /* gone */ }
  await srv.close();
  return { a1, b1, panel, planA, planB, reqTab, finalStatus };
};
