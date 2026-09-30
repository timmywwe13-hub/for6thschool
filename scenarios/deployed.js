// The deployed shape: the game on a file host, the lobby on another machine.
//
// This is what a school Chromebook actually uses - no folder, no terminal, no
// install - so it has to be asserted like everything else. Two servers, both
// started here:
//
//   * the game, served out of `web/` by a plain static file server that knows
//     nothing about the protocol (tools/web-build.js makes that folder, and this
//     scenario builds it first, so a missing asset shows up as a failed check
//     rather than as a broken deploy),
//   * the lobby, the real `lobby-server.js` relay, on a different port.
//
// The link that ties them together is the invite link: a page on one host, a
// relay on another, and `?relay=` carrying the difference. Two pages on two
// origins (127.0.0.1 and localhost) then behave like two real devices.
module.exports = async function deployed(ctx) {
  const { check, sleep, send } = ctx;
  const http = require('http');
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const relay = require('../lobby-server.js');

  const root = path.resolve(__dirname, '..');

  /* ---------- build the folder that gets deployed ----------
     Deliberately without the environment's project: this scenario drives its own
     local relay through `?relay=`, and a page with a real lobby baked in would
     start dialling it instead of the machine this scenario is watching. The
     real project is checked end to end by scenarios/live.js, which asks for it
     on purpose. */
  const build = execFileSync('node', [path.join(root, 'tools', 'web-build.js')], {
    encoding: 'utf8',
    env: Object.assign({}, process.env,
      { ISLE_SUPABASE_URL: '', ISLE_SUPABASE_KEY: '' })
  });
  const web = path.join(root, 'web');
  const hasIndex = fs.existsSync(path.join(web, 'index.html'));
  const indexBytes = hasIndex ? fs.statSync(path.join(web, 'index.html')).size : 0;
  check('tools/web-build.js produces the deployable folder',
    hasIndex && indexBytes > 100000 && !/NOT FOUND/.test(build),
    build.trim().split('\n').filter(l => /files,|NOT FOUND/.test(l)).join(' | '));

  /* ---------- a plain file server, and the lobby, on different ports ---------- */
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json' };
  const files = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
    const file = path.join(web, rel);
    if (!file.startsWith(web)) { res.writeHead(403); res.end('no'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not here'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
                           'content-length': buf.length });
      res.end(buf);
    });
  });
  const staticPort = await new Promise(resolve =>
    files.listen(0, '0.0.0.0', () => resolve(files.address().port)));

  const srv = await relay.start({ port: 0, quiet: true });
  const relayUrl = 'ws://127.0.0.1:' + srv.port + '/isle';
  const relayJson = await (await fetch('http://127.0.0.1:' + srv.port + '/relay.json')).json();
  check('the relay on the other machine is the only thing that speaks the protocol',
    Array.isArray(relayJson.rooms) && relayJson.clients === 0, JSON.stringify(relayJson));

  /* ---------- helpers, one CDP connection driving two pages ---------- */
  const evalOn = async (session, expr) => {
    const r = await send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, session);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page eval failed: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  };
  const until = async (session, expr, ms) => {
    const deadline = Date.now() + (ms || 15000);
    let last = null;
    for (;;) {
      try { last = await evalOn(session, expr); } catch (e) { last = null; }
      if (last) return last;
      if (Date.now() > deadline) return last;
      await sleep(150);
    }
  };
  const booted = session => until(session, `(function () {
    try {
      return !!(typeof App !== 'undefined' && App.state === 'MENU' &&
                document.getElementById('bootLoading').classList.contains('hidden'));
    } catch (e) { return false; }
  })()`, 40000);

  /* ---------- device one: the link somebody sends ---------- */
  const link = 'http://127.0.0.1:' + staticPort + '/?room=isle&relay=' + encodeURIComponent(relayUrl);
  await send('Page.navigate', { url: link });
  check('the game boots from a file host that only serves files', (await booted(undefined)) === true);

  /* The models have to come from that host as real .glb files - the whole reason
     tools/web-build.js can leave the 41 MB of .glb.js sidecars behind. The page's
     own resource log is the evidence: a .glb fetch, and no sidecar. */
  const model = await until(undefined, `(function () {
    const urls = performance.getEntriesByType('resource').map(function (e) { return e.name; });
    const glb = urls.filter(function (u) { return /[.]glb$/.test(u); });
    const report = (typeof Character !== 'undefined') ? Character.report() : '';
    /* the report says "Loading ..." until the model is really up, which is the
       moment this check is about */
    if (!glb.length || !/^You play as/.test(report)) return null;
    return { glb: glb.length, report: report,
             sidecars: urls.filter(function (u) { return /[.]glb[.]js$/.test(u); }).length };
  })()`, 40000);
  check('and its models load from that host as real .glb files, with no sidecars',
    !!model && model.glb >= 1 && model.sidecars === 0 && /^You play as/.test(String(model.report)),
    JSON.stringify(model));

  const online = await until(undefined, `(function () {
    return (Net.kind === 'socket' && Net.socket.readyState === 1)
      ? { relay: Net.relay, room: Net.room, status: Net.status() } : null;
  })()`, 25000);
  check('it joins the relay named in the link, with no click at all',
    !!online && online.relay === relayUrl && online.room === 'isle' &&
    /^RELAY/.test(String(online.status)), JSON.stringify(online));

  /* ---------- device two, on a second origin ---------- */
  const created = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const two = { targetId: created.targetId, session: attached.sessionId };
  two.send = (m, p) => send(m, p, two.session);
  two.eval = expr => evalOn(two.session, expr);
  await two.send('Runtime.enable');
  await two.send('Page.enable');
  await two.send('Page.navigate', { url: link.replace('127.0.0.1', 'localhost') });
  check('a second device boots the same game from the same link', (await booted(two.session)) === true);

  await evalOn(undefined, `(function () {
    const was = Net.me(); SETTINGS.name = 'Alice'; Net.rename(was); Modes.paint(); return true;
  })()`);
  await two.eval(`(function () {
    const was = Net.me(); SETTINGS.name = 'Bob'; Net.rename(was); Modes.paint(); return true;
  })()`);
  const seen = await until(undefined,
    `Net.livePeers().indexOf('Bob') >= 0 ? Net.livePeers().join(',') : null`, 25000);
  check('two devices on two origins find each other through the relay',
    seen === 'Bob', String(seen));

  /* ---------- the invite link from here has to carry the other host ---------- */
  const carried = await evalOn(undefined, `(function () {
    const out = Net.inviteLink();
    return { link: out, dialled: Net.normalize(out), room: Net.room };
  })()`);
  const wantTail = '?room=isle&relay=' + encodeURIComponent(relayUrl);
  check('its invite link carries the room and the relay, so it works for anybody',
    carried.link.slice(-wantTail.length) === wantTail && carried.dialled === relayUrl,
    carried.link);

  /* ---------- the friends path, across two hosts ---------- */
  const asked = await evalOn(undefined, `(function () {
    const input = document.getElementById('friendNameInput');
    input.value = 'Bob';
    document.getElementById('friendAddForm').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }));
    return { waiting: Friends.waiting('Bob'),
             chip: /REQUESTED/.test(document.getElementById('friendList').textContent) };
  })()`);
  check('ADD FRIEND asks over that relay',
    asked.waiting === true && asked.chip === true, JSON.stringify(asked));

  const got = await until(two.session, `(function () {
    const card = document.querySelector('#notifyAsks .notify.ask');
    return (Friends.pending('Alice') && card)
      ? { card: card.textContent.replace(/\\s+/g, ' ').trim(),
          buttons: card.querySelectorAll('button').length,
          badge: document.getElementById('freqBadge').textContent,
          row: document.querySelectorAll('#friendReqList [data-faq="Alice"]').length } : null;
  })()`, 20000);
  check('the other device is told, with the notification and its two answers',
    !!got && /ALICE ADDED YOU/.test(String(got.card)) && got.buttons === 2 &&
    got.badge === '1' && got.row === 1, JSON.stringify(got));

  await two.eval(`(function () {
    document.querySelector('#friendReqList [data-faq="Alice"]').click();
    return true;
  })()`);
  const mutual = await until(undefined, `Friends.mutual('Bob') ? 'mutual' : null`, 20000);
  check('and ACCEPT makes it a friendship on both machines at once',
    mutual === 'mutual', String(mutual));

  /* ---------- put it down ---------- */
  try { await send('Target.closeTarget', { targetId: two.targetId }); } catch (e) { /* gone */ }
  await srv.close();
  await new Promise(resolve => files.close(resolve));
  return { build: build.trim().split('\n').slice(-4).join(' | '), link, online, seen,
           carried, asked, got, mutual };
};
