// The rework, asserted: one box, two fields, once - and then never again.
//
// Every other transport scenario drives an address that was pasted into a box or
// arrived in a link (?relay=...). This one drives what a player actually does on
// the shipped site, which is nothing: the deploy folder has the Supabase project
// baked into it by tools/web-build.js (that is the command Netlify runs on every
// push, from netlify.toml), so the plain link - no query string, no pasting -
// opens the lobby on its own. It then walks the panel from the other end: a build
// with nothing baked in has to say so in two fields, take a real project through
// them, refuse half of one in words, and remember it, so the two fields are asked
// for once in a machine's life.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const supaFake = require('../tools/supa-fake.js');

module.exports = async function online(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const root = path.resolve(__dirname, '..');

  const fake = await supaFake.start({ port: 0, quiet: true });

  /* ---------- the build a push produces ----------
     ISLE_SUPABASE_URL and ISLE_SUPABASE_KEY are environment variables on the
     machine that runs the build - Netlify's site settings, or this repository's
     secrets - and they never go through git. This is the same command netlify.toml
     runs, so what is served below is exactly what players get. */
  let page = null;
  try {
    execFileSync('node', ['tools/web-build.js'], {
      cwd: root, stdio: 'pipe',
      env: Object.assign({}, process.env,
        { ISLE_SUPABASE_URL: fake.url, ISLE_SUPABASE_KEY: fake.key })
    });
    page = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  } catch (e) { /* the check below reports it */ }
  check('the build a push runs puts the Supabase project in the page',
    typeof page === 'string' && page.indexOf(fake.url) >= 0,
    typeof page === 'string' ? 'web/index.html is ' + page.length + ' bytes' : String(page));

  /* ---------- one file host serving both shapes ----------
     /web/index.html is the deploy folder (project baked in); /index.html is the
     source with an empty CONFIG, which is what a browser-only setup starts from. */
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json',
    '.fbx': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8' };
  const files = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(u.pathname.replace(/^\/+/, '')) || 'index.html';
    /* The game's one boot probe is GET /relay.json. A file host answers 404 and
       Chrome logs that as a console error even though the game handles it (see
       Net.autodial), so this host answers in JSON instead: a `clients` count with
       no rooms array is "not a lobby", which is exactly what autodial reads before
       it decides not to dial anything. */
    if (rel === 'relay.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ rooms: undefined, clients: 0 }));
      return;
    }
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

  /* ---------- helpers ---------- */
  const until = async (expr, ms) => {
    const deadline = Date.now() + (ms || 15000);
    let last = null;
    for (;;) {
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
  const go = async url => {
    await send('Page.navigate', { url });
    return booted();
  };
  /* what the ONLINE box is saying, and whether it is asking for anything.
     `want` is a substring the state has to have reached - a repaint runs on a
     timer, so reading it straight after a click can catch the previous words. */
  const panel = (want) => until(`(function () {
    var st = document.getElementById('netOnlineState');
    if (!st || /CHECKING/.test(st.textContent)) return null;
    if (${JSON.stringify(want || '')} &&
        st.textContent.indexOf(${JSON.stringify(want || '')}) < 0) return null;
    var form = document.getElementById('netOnlineForm');
    var edit = document.getElementById('btnOnlineEdit');
    return { state: st.textContent,
             formHidden: form.classList.contains('hidden'),
             editShown: !edit.classList.contains('hidden'),
             url: (document.getElementById('supaUrl') || {}).value || '',
             key: (document.getElementById('supaKey') || {}).value || '' };
  })()`, 10000);
  const joined = () => until(`Net.kind === 'supa' && Net.sb && Net.sb.joined ?
    { status: Net.status(), url: Net.supaUrl, relay: Net.relay } : null`, 25000);
  const click = expr => evaluate(`(function () {
    var el = ${expr};
    if (!el) return 'no such element';
    el.click(); return 'clicked'; })()`);

  /* ---------- one: the plain link, from the deploy folder ---------- */
  await go(base + 'web/index.html');
  const plain = await joined();
  const search = await evaluate('location.search');
  check('a plain link - no query string, nothing pasted - is in the lobby by itself',
    !!plain && plain.url === fake.url && /^supabase:/.test(String(plain.relay)) &&
    /^SUPABASE/.test(String(plain.status)) && search === '',
    JSON.stringify({ search: search, plain: plain }));
  check('because the project came out of the build, not out of anybody\'s typing',
    (await evaluate('CONFIG.SUPABASE_URL')) === fake.url);

  /* ---------- two: the panel has nothing to ask ---------- */
  await click(`document.getElementById('btnFriends')`);
  const baked = await panel('ONLINE');
  check('the FRIENDS panel says ONLINE and offers no fields for a baked project',
    !!baked && /ONLINE/.test(baked.state) && /SUPABASE/.test(baked.state) &&
    baked.formHidden === true && baked.editShown === true, JSON.stringify(baked));

  /* ---------- three: GO OFFLINE means "not connected", not "forgot it" ---------- */
  await click(`document.querySelector('[data-net="off"]')`);
  const afterOff = await panel('NOT CONNECTED');
  check('GO OFFLINE says set up, not connected - and still asks for nothing',
    !!afterOff && /NOT CONNECTED/.test(afterOff.state) && afterOff.formHidden === true &&
    (await evaluate('Net.kind')) !== 'supa', JSON.stringify(afterOff));

  /* ---------- four: CHANGE puts the two fields back, already filled in ---------- */
  await click(`document.getElementById('btnOnlineEdit')`);
  const editing = await panel();
  check('CHANGE shows the two fields with the project already in them',
    !!editing && editing.formHidden === false && editing.url === fake.url &&
    editing.key === fake.key, JSON.stringify(editing));

  /* ---------- five: what a browser-only setup starts from ---------- */
  await evaluate(`localStorage.clear(); true`);      // no saved project anywhere
  await go(base + 'index.html');                     // the source build, empty CONFIG
  const empty = await panel('NOT SET UP YET');
  check('with no project in the build, the panel says NOT SET UP YET in two fields',
    !!empty && empty.formHidden === false && empty.url === '' && empty.key === '',
    JSON.stringify(empty));

  /* ---------- six: half a project is refused in words ---------- */
  await click(`(function () {
    document.getElementById('supaUrl').value = 'the project';
    document.getElementById('supaKey').value = '';
    return document.querySelector('[data-net="online"]');
  })()`);
  const refused = await until(`(function () {
    var n = document.getElementById('netNote');
    if (!n || !/Supabase/.test(n.textContent)) return null;
    return { note: n.textContent, kind: Net.kind,
             state: document.getElementById('netOnlineState').textContent };
  })()`, 8000);
  check('a half-typed project is refused in a sentence that names the two fields',
    !!refused && refused.kind !== 'supa' && /NOT SET UP/.test(refused.state) &&
    /Project URL/.test(refused.note) && /key/.test(refused.note), JSON.stringify(refused));

  /* ---------- seven: the two fields, in full, work ---------- */
  await click(`(function () {
    document.getElementById('supaUrl').value = ${JSON.stringify(fake.url)};
    document.getElementById('supaKey').value = ${JSON.stringify(fake.key)};
    return document.querySelector('[data-net="online"]');
  })()`);
  const typed = await joined();
  const typedPanel = await panel('ONLINE');
  check('the two fields take a real project online, and the panel then says so',
    !!typed && typed.url === fake.url && !!typedPanel && typedPanel.formHidden === true,
    JSON.stringify({ typed: typed, panel: typedPanel }));

  /* ---------- eight: and that is the only time it is ever asked ---------- */
  await go(base + 'index.html');
  const again = await joined();
  const againPanel = await panel('ONLINE');
  check('a reload is online again with nothing typed, because the project was kept',
    !!again && again.url === fake.url && !!againPanel && againPanel.formHidden === true,
    JSON.stringify({ again: again, panel: againPanel }));

  /* The page stops dialling before the lobbies close, so the harness does not
     collect the honest "nothing answered" retries as console errors. */
  try { await evaluate(`(function () { Net.disconnect(); return Net.kind; })()`); } catch (e) { /* gone */ }
  await fake.close();
  await new Promise(resolve => files.close(resolve));
};
