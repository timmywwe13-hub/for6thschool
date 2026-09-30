// The real project, through the shipped game: what a laptop does with the plain
// link once the build carries a lobby.
//
// Every other scenario drives the fake Realtime server, because a test suite has
// to run on a fork that has no secrets and cannot talk to anybody's account. This
// one is the exception: it needs ISLE_SUPABASE_URL and ISLE_SUPABASE_KEY in the
// environment (the same pair the build takes, the same pair tools/supa-check.js
// takes) and it skips, cleanly and loudly, without them - so `npm run scenarios`
// stays green anywhere, and turns into the real end-to-end check on the machine
// that has the project: build with the project in it, serve the deploy folder,
// boot the game, and the game is online on a Supabase nobody is pretending is
// there. It then plays the second machine from Node over the identical wire
// (tools/supa-client.js), which is the two-laptop promise in one scenario.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SupaClient } = require('../tools/supa-client.js');

module.exports = async function live(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const root = path.resolve(__dirname, '..');
  const url = process.env.ISLE_SUPABASE_URL || '';
  const key = process.env.ISLE_SUPABASE_KEY || '';

  if (!url || !key) {
    console.log('no ISLE_SUPABASE_URL / ISLE_SUPABASE_KEY in the environment, so the real');
    console.log('project is not checked here - a fork has no secrets, and this suite has to');
    console.log('stay green without them. On the machine that does have them, this is the');
    console.log('whole game against it, and this is the protocol half:');
    console.log('  node tools/supa-check.js https://<project>.supabase.co <key>');
    return;
  }

  /* ---------- one: the deploy folder really carries the project ---------- */
  let page = null;
  let buildErr = '';
  try {
    execFileSync('node', ['tools/web-build.js'], {
      cwd: root, stdio: 'pipe',
      env: Object.assign({}, process.env,
        { ISLE_SUPABASE_URL: url, ISLE_SUPABASE_KEY: key })
    });
    page = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  } catch (e) { buildErr = e.message; }
  check('the deploy build carries the real Supabase project',
    typeof page === 'string' && page.indexOf(url) >= 0 && page.indexOf(key) >= 0,
    typeof page === 'string' ? 'web/index.html is ' + page.length + ' bytes' : buildErr);

  /* ---------- a plain file host for the deploy folder (see scenarios/online.js
     for why /relay.json is answered rather than left to 404) ---------- */
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json',
    '.fbx': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8' };
  const web = path.join(root, 'web');
  const files = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(u.pathname.replace(/^\/+/, '')) || 'index.html';
    if (rel === 'relay.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ rooms: undefined, clients: 0 }));
      return;
    }
    const file = path.join(web, rel);
    if (!file.startsWith(web)) { res.writeHead(403); res.end('no'); return; }
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

  /* ---------- helpers ---------- */
  const until = async (expr, ms) => {
    const deadline = Date.now() + (ms || 15000);
    for (;;) {
      let last = null;
      try { last = await evaluate(expr); } catch (e) { last = null; }
      if (last) return last;
      if (Date.now() > deadline) return last;
      await sleep(150);
    }
  };
  const booted = () => until(`(function () {
    try { return App.state === 'MENU' &&
      document.getElementById('bootLoading').classList.contains('hidden'); }
    catch (e) { return false; }
  })()`, 40000);

  /* ---------- two: the plain link, on the real project ---------- */
  await send('Page.navigate', { url: base + 'index.html' });
  await booted();
  const plain = await until(`Net.kind === 'supa' && Net.sb && Net.sb.joined ?
    { status: Net.status(), url: Net.supaUrl, room: Net.room, relay: Net.relay } : null`, 30000);
  check('the plain link is in the lobby on the real Supabase project',
    !!plain && plain.url === url && /^supabase:/.test(String(plain.relay)) &&
    /^SUPABASE/.test(String(plain.status)) && plain.room === 'isle',
    JSON.stringify(plain));

  /* ---------- three: the panel agrees, and is not asking for anything ---------- */
  await evaluate(`document.getElementById('btnFriends').click(); true`);
  const panel = await until(`(function () {
    var st = document.getElementById('netOnlineState');
    if (!st || /CHECKING/.test(st.textContent)) return null;
    var form = document.getElementById('netOnlineForm');
    return (/ONLINE/.test(st.textContent) && /SUPABASE/.test(st.textContent))
      ? { state: st.textContent, formHidden: form.classList.contains('hidden') } : null;
  })()`, 10000);
  check('the FRIENDS panel says ONLINE with the project in, and offers no fields',
    !!panel && panel.formHidden === true, JSON.stringify(panel));

  /* ---------- four: the second machine, on the identical wire ----------
     This is the two-laptop promise: a bare client - the shape a phone or a
     friend's machine is - joins the same channel of the real project and plays
     its presence the way the game does, and the roster has to fill in. */
  const room = (plain && plain.room) || 'isle';
  const cli = new SupaClient({ url, key, channel: room, name: 'Mallory' });
  let cliErr = '';
  try { await cli.open(15000); } catch (e) { cliErr = e.message; }
  check('a second machine joins the same channel on the real project',
    cli.joined === true, cliErr || cli.url);
  const say = () => {
    cli.send({ t: 'hello', id: 'Mallory' });
    cli.send({ t: 'presence', id: 'Mallory', name: 'Mallory', mode: 'duo',
               party: ['Mallory'], state: 'MENU' });
  };
  say();
  const heart = setInterval(say, 2000);

  const seen = await until(`(function () {
    var r = Net.rec('Mallory');
    return (r && r.mode === 'duo' && r.state === 'MENU')
      ? { mode: r.mode, state: r.state } : null;
  })()`, 30000);
  check('the game shows that machine in the roster, complete with mode and state',
    !!seen, JSON.stringify(seen));

  /* ---------- five: and the second machine hears the page ----------
     The roster runs on the game's own 4s presence message, so this waits for
     one of those to arrive over the real network rather than assuming the
     direction that a join implies. */
  let back = false;
  for (let i = 0; i < 60 && !back; i++) {
    back = cli.messages.some(m => m.t === 'presence' && m.id && m.id !== 'Mallory');
    if (!back) await sleep(500);
  }
  check("the page's own presence reaches the second machine (both directions)",
    back, cli.messages.length + ' message(s) reached it');

  /* ---------- put it down before the harness collects retry noise ---------- */
  clearInterval(heart);
  cli.close();
  try { await evaluate(`(function () { Net.disconnect(); return Net.kind; })()`); } catch (e) { /* gone */ }
  await sleep(300);
  await new Promise(resolve => files.close(resolve));
};
