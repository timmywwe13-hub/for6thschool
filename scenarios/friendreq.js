// Friends, the request that makes them friends, and being online all the time.
//
// Two real browser pages and one raw websocket client, through the shipped
// relay, driven the way a player drives it:
//
//   * the page puts itself in the lobby with no CONNECT press (the host answers
//     /relay.json), and a socket that dies is dialled again on its own
//   * ADD FRIEND is a real request: the other device gets a notification in the
//     lane, a badge count and a row in REQUESTS, and answering it makes the two
//     lists agree - both ways, and still there after a reload
//   * a request made while the other player is offline is re-sent the moment
//     their hello arrives, so it only has to be made once
//   * DECLINE says no and takes the name off the list that asked
//   * a friend row is honest: ONLINE is a peer the transport is hearing from
//     this second, and anything else reads OFFLINE with a time on it
module.exports = async function friendreq(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const path = require('path');
  const relay = require('../lobby-server.js');

  const srv = await relay.start({ port: 0, quiet: true });
  /* Two origins, one relay. A browser gives every origin its own localStorage,
     so serving the second device from `localhost` while the first one uses
     `127.0.0.1` is what two real machines look like - otherwise they would
     share one friends list (same origin, same storage) and every check about
     who knows whom would be measuring the wrong thing. */
  const base = 'http://127.0.0.1:' + srv.port + '/';
  const baseB = 'http://localhost:' + srv.port + '/';
  const isle = 'ws://127.0.0.1:' + srv.port + '/isle';

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
  /* rename this device and stay online: the game's own path (Net.rename), which
     says bye as the old name so no ghost is left in anybody's roster, then
     introduces the new one */
  const rename = (session, name) => evalOn(session, `(function () {
    const was = Net.me();
    SETTINGS.name = '` + name + `';
    Net.rename(was);
    Modes.paint();
    return Net.me();
  })()`);

  /* ---------- online with nobody asking ---------- */
  await send('Page.navigate', { url: base });
  check('the game boots when the lobby server is the one serving it',
    (await booted(undefined)) === true);
  const auto = await until(undefined, `(function () {
    return (Net.kind === 'socket' && !!Net.socket && Net.socket.readyState === 1)
      ? { kind: Net.kind, relay: Net.relay, room: Net.room, want: Net.wantOnline,
          status: Net.status() } : null;
  })()`, 25000);
  check('it joins the lobby on load, with no CONNECT press at all',
    !!auto && auto.want === true && auto.room === 'isle' && /^RELAY/.test(String(auto.status)),
    JSON.stringify(auto));
  const greeted = await evaluate('Net.greeted');
  check('and the relay greets it, which is what proves the connection is really end to end',
    typeof greeted === 'number' && greeted > 0, String(greeted));

  /* ---------- a socket that dies comes back on its own ---------- */
  await evaluate(`(function () { Net.socket.close(); return true; })()`);
  const died = await until(undefined,
    `Net.kind === 'off' ? Net.status() : null`, 8000);
  check('closing the socket is noticed, and it says it is coming back',
    /RECONNECTING/.test(String(died)), String(died));
  const back = await until(undefined,
    `(Net.kind === 'socket' && Net.socket.readyState === 1) ? Net.relay : null`, 20000);
  check('and it dials the relay again without anybody pressing anything',
    /^ws:\/\/127\.0\.0\.1:\d+\/isle$/.test(String(back)), String(back));

  /* ---------- device two ---------- */
  const created = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const two = { targetId: created.targetId, session: attached.sessionId };
  two.send = (m, p) => send(m, p, two.session);
  two.eval = expr => evalOn(two.session, expr);
  await two.send('Runtime.enable');
  await two.send('Log.enable');
  await two.send('Page.enable');
  await two.send('Page.navigate', { url: baseB });
  check('a second device boots the same game', (await booted(two.session)) === true);
  await rename(undefined, 'Alice');
  await rename(two.session, 'Bob');
  const together = await pollA(`(function () {
    return (Net.livePeers().indexOf('Bob') >= 0 && Net.livePeers().length === 1)
      ? Net.livePeers().join(',') : null;
  })()`, 25000);
  check('both devices are online and see each other', together === 'Bob', String(together));

  /* ---------- ADD FRIEND is a request, not a note in a local file ---------- */
  const asked = await evaluate(`(function () {
    document.getElementById('btnFriends').click();
    const input = document.getElementById('friendNameInput');
    input.value = 'Bob';
    document.getElementById('friendAddForm').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }));
    const row = document.querySelector('#friendList [data-fremove="Bob"]');
    return { mine: Friends.isFriend('Bob'), waiting: Friends.waiting('Bob'),
             outgoing: Friends.outgoing().map(function (r) { return r.name; }).join(','),
             chip: /REQUESTED/.test(document.getElementById('friendList').textContent),
             row: !!row, name: input.value };
  })()`);
  check('ADD FRIEND keeps the name here and asks them outright',
    asked.mine === true && asked.waiting === true && asked.outgoing === 'Bob' &&
    asked.chip === true && asked.row === true && asked.name === '',
    JSON.stringify(asked));

  const gotAsk = await until(two.session, `(function () {
    const lane = document.getElementById('notifyAsks');
    const card = lane ? lane.querySelector('.notify.ask') : null;
    const badge = document.getElementById('freqBadge');
    const pending = Friends.pending('Alice');
    if (!pending || !card) return null;
    return { pending: pending, mutual: Friends.mutual('Alice'),
             card: card.textContent.replace(/\\s+/g, ' ').trim(),
             buttons: card.querySelectorAll('button').length,
             badge: badge ? badge.textContent : '', badgeHidden: badge ? badge.className : '',
             tab: document.getElementById('frReqTab').textContent,
             row: document.querySelectorAll('#friendReqList [data-faq="Alice"]').length,
             list: Friends.isFriend('Alice') };
  })()`, 20000);
  check('the other device is told, with a notification that carries the answer',
    !!gotAsk && gotAsk.mutual === false && gotAsk.list === false &&
    /ALICE ADDED YOU/.test(String(gotAsk.card)) && gotAsk.buttons === 2,
    JSON.stringify(gotAsk));
  check('and the badge, the tab and the REQUESTS row count it',
    !!gotAsk && gotAsk.badge === '1' && gotAsk.tab === '1' && gotAsk.row === 1,
    gotAsk && ('badge ' + gotAsk.badge + ', tab ' + gotAsk.tab + ', rows ' + gotAsk.row));

  /* ---------- ACCEPT: the list goes both ways ---------- */
  const accepted = await two.eval(`(function () {
    document.querySelector('#frTabs [data-frtab="requests"]').click();
    document.querySelector('#friendReqList [data-faq="Alice"]').click();
    const badge = document.getElementById('freqBadge');
    return { mine: Friends.isFriend('Alice'), mutual: Friends.mutual('Alice'),
             lane: document.getElementById('notifyAsks').textContent.trim(),
             badge: badge ? badge.textContent : '', badgeHidden: badge ? badge.className : '',
             tab: document.getElementById('frReqTab').textContent,
             friends: Friends.count(), rows: document.getElementById('friendList').textContent };
  })()`);
  check('ACCEPT puts them on my list, as a friend, and clears the request',
    accepted.mine === true && accepted.mutual === true && accepted.friends === 1 &&
    accepted.lane === '' && accepted.badge === '0' && accepted.tab === '0',
    JSON.stringify(accepted));
  const mutualSeen = await pollA(`Friends.mutual('Bob') ? 'mutual' : null`, 20000);
  const toldBack = await evaluate(`(function () {
    return { mutual: Friends.mutual('Bob'), waiting: Friends.waiting('Bob'),
             toasts: document.querySelectorAll('#notifyToasts .notify.ok').length,
             lane: document.getElementById('notifyToasts').textContent.trim(),
             row: document.getElementById('friendList').textContent.replace(/\\s+/g, ' ') };
  })()`);
  check('and the device that asked is told, in the lane and in the row',
    mutualSeen === 'mutual' && toldBack.toasts >= 1 && toldBack.waiting === false &&
    /FRIEND/.test(toldBack.row),
    JSON.stringify(toldBack));

  /* ---------- it survives a reload, on both sides ---------- */
  await two.send('Page.navigate', { url: baseB });
  check('the accepting device reloads', (await booted(two.session)) === true);
  const persisted = await until(two.session, `(function () {
    return (Net.kind === 'socket' && Net.socket.readyState === 1 &&
            Friends.isFriend('Alice') && Friends.mutual('Alice'))
      ? { friends: Friends.count(), mutual: Friends.mutual('Alice') } : null;
  })()`, 25000);
  check('a friendship made here is still there after a reload, and it re-joins the lobby',
    !!persisted && persisted.friends === 1, JSON.stringify(persisted));

  /* ---------- a raw player, for the paths a browser drives awkwardly ---------- */
  function rawPlayer(name) {
    const ws = new WebSocket(isle);
    ws.ready = new Promise(res => ws.addEventListener('open', res));
    ws.log = [];
    ws.addEventListener('message', e => ws.log.push(JSON.parse(e.data)));
    ws.say = () => ws.send(JSON.stringify({ t: 'presence', id: name, party: [name],
                                            mode: 'solo', state: 'MENU', open: true }));
    ws.ready.then(() => {
      ws.send(JSON.stringify({ t: 'hello', id: name }));
      ws.say();
      ws.heart = setInterval(ws.say, 2000);
    });
    ws.wants = t => ws.log.filter(m => m.t === t);
    return ws;
  }
  async function untilNode(fn, ms) {
    const deadline = Date.now() + (ms || 15000);
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(150);
    }
  }

  /* ---------- the heartbeat does not depend on the timer ----------
     A tab in the background has its timers throttled, so the transport
     re-announces on any message that arrives. With the timer switched off, only
     an incoming packet can keep this player's presence alive. */
  const mallory = rawPlayer('Mallory');
  await mallory.ready;
  await pollA(`Net.isLive('Mallory') ? true : null`, 20000);
  await evaluate(`(function () { Net.stopHeart(); Net.lastAnnounce = 0; return true; })()`);
  const woke = await until(undefined,
    `Net.lastAnnounce > 0 ? (Date.now() - Net.lastAnnounce) : null`, 15000);
  check('a message from the room re-announces for a tab whose timer is throttled',
    typeof woke === 'number' && woke < 4000, String(woke) + ' ms after the last announce');
  await evaluate(`(function () { Net.startHeart(); return true; })()`);

  /* ---------- DECLINE ---------- */
  mallory.send(JSON.stringify({ t: 'fask', id: 'Mallory', to: 'Alice' }));
  const laneAsk = await until(undefined, `(function () {
    const card = document.querySelector('#notifyAsks .notify.ask');
    return card ? card.textContent.replace(/\\s+/g, ' ').trim() : null;
  })()`, 20000);
  check('a request from another machine lands in the lane as well',
    /MALLORY ADDED YOU/.test(String(laneAsk)), String(laneAsk));
  await evaluate(`(function () {
    document.querySelector('#notifyAsks [data-ndec="Mallory"]').click();
    return true;
  })()`);
  const declined = await until(undefined, `(function () {
    return (!Friends.pending('Mallory') && !Friends.isFriend('Mallory'))
      ? { friend: Friends.isFriend('Mallory'),
          lane: document.getElementById('notifyAsks').textContent.trim() } : null;
  })()`, 12000);
  check('DECLINE clears the request and keeps the name off the list',
    !!declined && declined.lane === '', JSON.stringify(declined));
  const toldNo = await untilNode(() => mallory.wants('fdec')[0], 8000);
  check('and the machine that asked is told no', !!toldNo && toldNo.to === 'Mallory',
    JSON.stringify(toldNo));

  /* ---------- asked while they are away, delivered when they come back ---------- */
  mallory.close();
  clearInterval(mallory.heart);
  await pollA(`!Net.isLive('Mallory') ? 'gone' : null`, 15000);
  const askedOffline = await evaluate(`(function () {
    const input = document.getElementById('friendNameInput');
    input.value = 'Mallory';
    document.getElementById('friendAddForm').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }));
    const rows = document.querySelectorAll('#friendList .frPlayer');
    let text = '';
    for (let i = 0; i < rows.length; i++) {
      if (/Mallory/.test(rows[i].textContent)) text = rows[i].textContent.replace(/\\s+/g, ' ');
    }
    return { waiting: Friends.waiting('Mallory'), text: text.trim() };
  })()`);
  check('a request made while they are offline is kept, and the row says what happens next',
    askedOffline.waiting === true && /REQUESTED/.test(askedOffline.text) &&
    /back online/.test(askedOffline.text), JSON.stringify(askedOffline));

  const mallory2 = rawPlayer('Mallory');
  await mallory2.ready;
  const redelivered = await untilNode(() => mallory2.wants('fask')[0], 15000);
  check('and it is delivered by itself the moment they come back',
    !!redelivered && redelivered.to === 'Mallory', JSON.stringify(redelivered));
  mallory2.send(JSON.stringify({ t: 'facc', id: 'Mallory', to: 'Alice' }));
  const mutual = await pollA(`Friends.mutual('Mallory') ? Friends.inspect().list.map(function (f) {
    return f.name + (f.mutual ? ':mutual' : ':pending');
  }).join(',') : null`, 15000);
  check('their yes makes it a friendship on both sides here too',
    /Mallory:mutual/.test(String(mutual)), String(mutual));

  /* ---------- the row is honest about who is really here ---------- */
  const live = await evaluate(`(function () {
    return { mallory: Friends.online('Mallory'), bob: Friends.online('Bob'),
             status: Net.status() };
  })()`);
  check('a friend the transport is hearing from reads online, and so does the other device',
    live.mallory === true && live.bob === true && /^RELAY/.test(String(live.status)),
    JSON.stringify(live));
  mallory2.close();
  clearInterval(mallory2.heart);
  const awayAgain = await pollA(`(function () {
    if (Friends.online('Mallory')) return null;
    const rows = document.querySelectorAll('#friendList .frPlayer');
    for (let i = 0; i < rows.length; i++) {
      const text = rows[i].textContent.replace(/\\s+/g, ' ');
      if (/Mallory/.test(text)) return { online: Friends.online('Mallory'), row: text.trim() };
    }
    return null;
  })()`, 15000);
  check('and when they leave, the row says OFFLINE and when they were last seen',
    !!awayAgain && /OFFLINE/.test(awayAgain.row) && /last seen|seen just now/.test(awayAgain.row),
    awayAgain && awayAgain.row);

  /* ---------- the address box takes whatever a friend sends ----------
     A player is going to paste a link, or the line the lobby printed, and all of
     it has to end up as one relay URL with the room in the path. */
  const forms = await evaluate(`(function () {
    const host = '127.0.0.1:' + ` + srv.port + `;
    const was = Net.relay;
    /* the game served by one host and the lobby running on another - the shape a
       Netlify page hands out. The link has to carry the relay, or the friend
       opens the game and lands in a lobby that is not there. */
    Net.relay = 'wss://relay.example/isle';
    const sent = Net.inviteLink();
    Net.relay = Net.roomUrl(Net.room);
    const sentHere = Net.inviteLink();
    Net.relay = was;
    return {
      bare: Net.normalize(host),
      bareRoom: Net.normalize(host + '/trios'),
      relayLine: Net.normalize('ws://' + host + '/isle'),
      inviteHere: Net.normalize('http://' + host + '/?room=trios'),
      inviteElsewhere: Net.normalize('https://someone.github.io/22/?room=iso&relay=' +
        encodeURIComponent('wss://relay.example/isle')),
      junk: Net.normalize('hello there'),
      room: Net.room,
      sent: sent,
      sentBack: Net.normalize(sent),
      sentHere: sentHere
    };
  })()`);
  check('the address box takes a host, a relay line, and an invite link',
    forms.bare === 'ws://127.0.0.1:' + srv.port + '/isle' &&
    forms.bareRoom === 'ws://127.0.0.1:' + srv.port + '/trios' &&
    forms.relayLine === 'ws://127.0.0.1:' + srv.port + '/isle' &&
    forms.inviteHere === 'ws://127.0.0.1:' + srv.port + '/trios',
    JSON.stringify(forms));
  check('an invite link from another host carries its relay out',
    forms.inviteElsewhere === 'wss://relay.example/iso', String(forms.inviteElsewhere));
  check('and nonsense is refused instead of dialled', forms.junk === '', String(forms.junk));
  check('the link a player sends carries the relay when the lobby is on another host',
    forms.sent === 'http://127.0.0.1:' + srv.port + '/?room=' + forms.room + '&relay=' +
      encodeURIComponent('wss://relay.example/isle') &&
    forms.sentBack === 'wss://relay.example/isle',
    JSON.stringify({ sent: forms.sent, back: forms.sentBack }));
  check('and it stays short when the lobby IS the host that served the game',
    forms.sentHere === 'http://127.0.0.1:' + srv.port + '/?room=' + forms.room,
    String(forms.sentHere));

  /* ---------- the folder on a stick ----------
     The copy that travels on a USB stick is opened as a file://, which has no
     URL of its own to send. That is the whole point of linkFromRelay: the relay
     serves the same game, so its web address is a link a friend can click. */
  const htmlPath = path.resolve(__dirname, '..', 'index.html').split(String.fromCharCode(92)).join('/');
  await two.send('Page.navigate', { url: 'file:///' + htmlPath });
  check('a copy of the folder boots from a file:// page', (await booted(two.session)) === true);
  const usb = await two.eval(`(function () {
    Net.relay = 'ws://127.0.0.1:` + srv.port + `/isle';
    const link = Net.inviteLink();
    return { protocol: location.protocol, link: link, dialled: Net.normalize(link),
             offline: Net.kind };
  })()`);
  check('from a copied folder, COPY INVITE LINK hands out a link that works',
    usb.protocol === 'file:' && usb.link === 'http://127.0.0.1:' + srv.port + '/?room=isle',
    JSON.stringify(usb));
  check('and pasting that link back dials the relay it names',
    usb.dialled === 'ws://127.0.0.1:' + srv.port + '/isle', String(usb.dialled));
  const joined = await two.eval(`(function () {
    const ok = Net.connectRelay(Net.inviteLink());
    return { ok: ok, relay: Net.relay, room: Net.room, want: Net.wantOnline };
  })()`);
  check('so a friend who pastes the link the host sent is in that lobby',
    joined.ok === true && joined.relay === 'ws://127.0.0.1:' + srv.port + '/isle' &&
    joined.room === 'isle' && joined.want === true, JSON.stringify(joined));

  /* ---------- put it down ---------- */
  try { await send('Target.closeTarget', { targetId: two.targetId }); } catch (e) { /* gone */ }
  /* The page is told before the lobby goes away: a transport left running would
     spend the next seconds honestly reporting that the relay it was told to use
     has stopped answering, and the harness collects those retry failures as
     console errors. They are correct behaviour, and nothing to do with the code
     under test. */
  try { await evaluate(`(function () { Net.disconnect(); return Net.kind; })()`); } catch (e) { /* gone */ }
  await srv.close();
  return { auto, back, together, asked, gotAsk, accepted, toldBack, persisted, woke,
           laneAsk, declined, toldNo, askedOffline, redelivered, mutual, live, awayAgain,
           forms, usb };
};
