// _frshot probe: opens the friends panel with real players in the lobby and
// photographs it, so the layout can be looked at instead of described.
// Run it with:  node cdp-test.js _frshot
//
// It brings up its own relay (lobby-server.js) and plays the other devices with raw
// websockets - one queueing duos (joinable), one solo, one closed party, plus a
// friend that is offline - which is the whole point: the panel is being judged
// with real presence in it, not with hand-written fixtures.
const fs = require('fs');
const path = require('path');
const relay = require('../lobby-server.js');

module.exports = async function frshot(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const OUT = path.join(__dirname, '..', 'playtest');
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await relay.start({ port: 0, quiet: true });
  const base = 'http://127.0.0.1:' + srv.port + '/';

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  }
  const until = async (expr, ms) => {
    const deadline = Date.now() + (ms || 9000);
    for (;;) {
      const v = await evaluate(expr);
      if (v) return v;
      if (Date.now() > deadline) return v;
      await sleep(150);
    }
  };
  const peers = [];
  const peer = async (name, mode, party, open) => {
    const ws = new WebSocket('ws://127.0.0.1:' + srv.port + '/isle');
    await new Promise(res => ws.addEventListener('open', res));
    const say = () => ws.send(JSON.stringify({ t: 'presence', id: name, party: party,
                                               mode: mode, state: 'MENU', open: open }));
    ws.send(JSON.stringify({ t: 'hello', id: name }));
    say();
    /* the real client re-announces every 4 s (`Net.startHeart`); a raw peer has
       to do the same or it only exists for the moment it said hello */
    ws.heart = setInterval(say, 2000);
    peers.push(ws);
    return ws;
  };
  const stopPeers = () => peers.forEach(p => { clearInterval(p.heart); p.close(); });

  await send('Page.navigate', { url: base });
  check('the game boots off the lobby server',
    (await until(`(function () { try { return !!(typeof App !== 'undefined' &&
      App.state === 'MENU' && document.getElementById('bootLoading').classList.contains('hidden')); }
      catch (e) { return false; } })()`, 40000)) === true);

  const roster = [
    await peer('Kayso', 'squad', ['Kayso', 'd7_dy'], true),
    await peer('Sp3rAnZa01', 'duo', ['Sp3rAnZa01'], true),
    await peer('Joseph-s2006', 'trio', ['Joseph-s2006'], false),
    await peer('gleaming_deer92', 'solo', ['gleaming_deer92'], true)
  ];

  await evaluate(`(function () {
    SETTINGS.name = 'blrgaminator';
    Net.connect('isle');
    Friends.add('SquadMate');          // an offline friend, so a grey row shows
    Teams.setMode('duo');
    return true;
  })()`);
  await until(`Net.kind === 'socket' && Net.socket.readyState === 1 && Net.livePeers().length === 4`);
  await evaluate(`document.getElementById('btnFriends').click(); Teams.paint(); 'open'`);
  await sleep(600);
  await shot('_friends-panel-all');

  await evaluate(`(function () { document.querySelector('[data-frtab="joinable"]').click();
    Teams.paint(); return 1; })()`);
  await sleep(400);
  await shot('_friends-panel-joinable');

  /* close the party, then let somebody ask to join: that is the flow the
     REQUESTS tab exists for, and it is driven through the real buttons */
  await evaluate(`(function () {
    document.querySelector('[data-net="privacy"]').click();
    return Net.partyOpen;
  })()`);
  const asker = await peer('Anon-Requester', 'solo', ['Anon-Requester'], false);
  asker.send(JSON.stringify({ t: 'join', id: 'Anon-Requester', to: 'blrgaminator' }));
  await until(`Net.requests.length === 1`);
  await evaluate(`(function () { document.querySelector('[data-frtab="requests"]').click();
    Teams.paint(); return 1; })()`);
  await sleep(400);
  await shot('_friends-panel-requests');

  console.log('  peers seen: ' + (await evaluate(`Net.livePeers().join(',')`)));
  console.log('  joinable:   ' + (await evaluate(`Teams.joinablePeers().map(function (r) { return r.rec.name; }).join(',')`)));
  console.log('  requests:   ' + (await evaluate(`Net.requests.map(function (r) { return r.name; }).join(',')`)));
  check('the probe left the panel populated', (await evaluate(`Net.livePeers().length`)) === 5);

  stopPeers();
  await srv.close();
};
