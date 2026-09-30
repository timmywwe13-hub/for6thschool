// Who is in the lobby right now - a watcher, not a player.
//
// It asks the relay's own /relay.json for its numbers, then opens one socket,
// says hello, and prints every presence it hears for a few seconds. That is what
// tells "the two devices cannot see each other" apart from "one device is not
// connected at all", and it shows the names - which matters, because two players
// with the SAME name are invisible to each other on purpose.
//
//   node tools/relay-watch.js                             the deployed relay
//   node tools/relay-watch.js wss://other-host/isle        another relay
//   node tools/relay-watch.js wss://host/isle 30           watch for 30 seconds
const RELAY = process.argv[2] || 'wss://glad-mustang-5022.timmywwe13-hub.deno.net/isle';
const SECONDS = Number(process.argv[3] || 15);
const WATCHER = 'Watcher-' + Math.random().toString(36).slice(2, 6);

const http = RELAY.replace(/^ws/, 'http').replace(/\/[^/]*$/, '');
const seen = new Map();          // name (lower case) -> what they said

(async function () {
  console.log('relay     ' + RELAY);
  try {
    const landing = await fetch(http + '/');
    console.log('landing   HTTP ' + landing.status + ' ' +
      (/ISLE ROYALE LOBBY/.test(await landing.text()) ? '(says the lobby is up)' : '(not the lobby page)'));
  } catch (e) {
    console.log('landing   could not be reached: ' + e.message);
  }
  try {
    const info = await (await fetch(http + '/relay.json')).json();
    console.log('relay.json ' + JSON.stringify(info));
    if (!info.clients) console.log('          -> nobody is connected. A game left open is NOT talking to this relay.');
  } catch (e) {
    console.log('relay.json could not be read: ' + e.message);
  }

  const ws = new WebSocket(RELAY);
  let opened = false;
  const started = Date.now();
  let closedAt = 0;
  /* A heartbeat like the game's own (presence every 4 s). ISLE_QUIET=1 leaves the
     socket silent instead, which is the useful comparison: a Deno Deploy app is
     only kept alive by traffic - "WebSocket connections that actively transmit
     data (including ping/pong frames) also keep the application alive" - so a
     silent socket can die with the app while a chatty one survives. */
  const quiet = !!process.env.ISLE_QUIET;
  const heart = quiet ? null : setInterval(function () {
    try {
      ws.send(JSON.stringify({ t: 'presence', id: WATCHER, party: [WATCHER], mode: 'solo',
                               state: 'MENU', open: true }));
    } catch (e) { /* gone */ }
  }, 4000);
  ws.onclose = function (ev) {
    closedAt = Date.now();
    console.log('socket    CLOSED after ' + ((closedAt - started) / 1000).toFixed(1) + 's   code ' +
      ev.code + (ev.reason ? '  "' + ev.reason + '"' : '') +
      (ev.wasClean ? '  (clean)' : '  (NOT clean - a network or platform drop)'));
  };
  /* While this socket is open, what does the relay's own /relay.json say? If it
     keeps answering `clients: 0` while a socket is demonstrably connected, then
     HTTP requests and websockets are landing on DIFFERENT instances of the app -
     and two players can sit in the same room name on different instances and
     never hear each other, which is the one failure a serverless host can cause
     and a local relay cannot. */
  let ticks = 0;
  const probe = setInterval(async function () {
    ticks++;
    try {
      const info = await (await fetch(http + '/relay.json')).json();
      console.log('  probe ' + ticks + '   I am connected, and relay.json says ' + JSON.stringify(info));
      if (opened && info.clients === 0) {
        console.log('           ^^^ HTTP says nobody is here while my socket is open:');
        console.log('               the relay is running as MORE THAN ONE instance.');
      }
    } catch (e) {
      console.log('  probe ' + ticks + '   relay.json unreachable: ' + e.message);
    }
  }, 4000);
  ws.onopen = function () {
    opened = true;
    console.log('socket    connected as ' + WATCHER + ' - watching for ' + SECONDS + 's');
    ws.send(JSON.stringify({ t: 'hello', id: WATCHER }));
    ws.send(JSON.stringify({ t: 'presence', id: WATCHER, party: [WATCHER], mode: 'solo',
                             state: 'MENU', open: true }));
  };
  ws.onmessage = function (ev) {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.t === 'presence' || msg.t === 'hello') {
      const key = String(msg.id || '').toLowerCase();
      const was = seen.get(key);
      if (!was || was.state !== msg.state) {
        seen.set(key, msg);
        console.log('  ' + (msg.id || '?') + '   ' + (msg.mode || '?') + '   ' +
          (msg.state || '?') + '   party ' + JSON.stringify(msg.party || []) +
          (was ? '   (changed)' : '   <- first time seen'));
      }
    } else if (msg.t === 'bye') {
      console.log('  ' + msg.id + '   left');
    }
  };
  ws.onerror = function () {
    console.log('socket    could not connect to ' + RELAY +
      '\n          (a ws:// address from a web host will be refused as mixed content; this needs wss://)');
  };

  setTimeout(function () {
    clearInterval(probe);
    if (heart) clearInterval(heart);
    const lived = ((closedAt || Date.now()) - started) / 1000;
    console.log('socket    ' + (closedAt ? 'dropped after ' : 'still open after ') +
      lived.toFixed(1) + 's  (' + (quiet ? 'silent socket' : 'heartbeat every 4s') + ')');
    const names = Array.from(seen.values()).map(function (m) { return m.id; });
    console.log('\n' + (opened ? 'in this room: ' : 'never connected - in this room: ') +
      (names.length ? names.join(', ') : 'nobody else'));
    if (!names.length && opened) {
      console.log('  -> nobody else is here. A game left open on the wrong relay (or not');
      console.log('     connected at all) looks exactly like this from the outside.');
    }
    console.log('  note: everything keys on the player NAME, so two people who both left it');
    console.log('        as "Recruit" cannot see each other - SETTINGS -> PLAYER NAME.');
    try { ws.close(); } catch (e) { /* gone */ }
    process.exit(0);
  }, SECONDS * 1000);
})();
