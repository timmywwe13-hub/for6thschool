// Is this Supabase project a lobby the game can use? One command, no account
// needed for the answer.
//
//   node tools/supa-check.js                       the fake server - offline, and
//                                                  what the test suite runs
//   node tools/supa-check.js https://xyz.supabase.co sb_publishable_...
//   ISLE_SUPABASE_URL=... ISLE_SUPABASE_KEY=... node tools/supa-check.js
//
// It speaks the protocol the game speaks (tools/supa-client.js is the same wire
// as `connectSupabase` in index.html) and asserts what a lobby is for: two
// clients on a channel see each other, a broadcast crosses between them, the
// sender does not hear its own, a private message crosses intact, a closed
// client is known to be gone at once rather than after a timeout, and a second
// channel sees none of it. On a real project it also prints the one-line address
// to paste into the game's FRIENDS panel.
//
// A real project is checked on a channel of its own (`check-xxxxxx`), so running
// this never disturbs a lobby somebody is playing in.
'use strict';

const { SupaClient } = require('./supa-client.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const GIVEN_URL = args[0] || process.env.ISLE_SUPABASE_URL || '';
const GIVEN_KEY = args[1] || process.env.ISLE_SUPABASE_KEY || '';
const GIVEN_CHANNEL = args[2] || process.env.ISLE_SUPABASE_CHANNEL || '';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name +
    (detail === undefined || detail === '' ? '' : '   [' + String(detail).slice(0, 220) + ']'));
}
/* poll rather than sleep, so a slow project is not a failed check */
async function until(fn, ms) {
  const deadline = Date.now() + (ms || 3000);
  for (;;) {
    try { if (fn()) return true; } catch (e) { /* keep asking */ }
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

(async function () {
  let fake = null;
  let url = GIVEN_URL;
  let key = GIVEN_KEY;
  let channel = GIVEN_CHANNEL;
  if (!url) {
    const { start } = require('./supa-fake.js');
    fake = await start({ port: 0, quiet: true });
    url = fake.url;
    key = fake.key;
    channel = 'isle';
    console.log('No project given, so this runs against the fake Realtime server on ' + url + '.');
    console.log('For a real one:  node tools/supa-check.js https://<project>.supabase.co <key>\n');
  } else {
    if (!key) {
      console.error('FAIL  a project needs its key too: node tools/supa-check.js <url> <key>');
      process.exit(2);
    }
    if (!channel) channel = 'check-' + Math.random().toString(36).slice(2, 8);
    console.log('Checking ' + url + ' on channel "' + channel + '" (a channel of its own, so');
    console.log('a lobby somebody is playing in is left alone).\n');
  }

  /* ---------- the two clients ---------- */
  const a = new SupaClient({ url: url, key: key, channel: channel, name: 'Alice' });
  const b = new SupaClient({ url: url, key: key, channel: channel, name: 'Bob' });
  let aErr = '';
  let bErr = '';
  try { await a.open(15000); } catch (e) { aErr = e.message; }
  check('a client joins the channel', a.joined === true && !aErr, aErr || a.url);
  if (!a.joined) {
    console.log('\nNothing else can be checked without a channel. The two usual reasons: a wrong');
    console.log('key or URL, or Realtime switched off for the project (Supabase > Project');
    console.log('settings > API keys has the pair; DEPLOY-ONLINE.md 2b has the setup).');
    process.exit(2);
  }

  try { await b.open(15000); } catch (e) { bErr = e.message; }
  check('a second client joins the same channel', b.joined === true && !bErr, bErr);

  check('each client sees the other on presence',
    await until(() => a.peers.size === 1 && b.peers.size === 1, 4000),
    'A sees ' + a.peers.size + ', B sees ' + b.peers.size);

  /* ---------- the game's own message set, over a broadcast ---------- */
  b.messages.length = 0;
  a.messages.length = 0;
  a.send({ t: 'presence', id: 'Alice', party: ['Alice'], mode: 'duo', state: 'MENU' });
  check('a broadcast crosses from one client to the other',
    await until(() => b.messages.some(m => m.t === 'presence' && m.id === 'Alice'), 4000),
    JSON.stringify(b.messages.slice(-2)));
  check('and the sender does not hear its own broadcast (self:false)',
    !a.messages.some(m => m.t === 'presence'),
    a.messages.length + ' message(s) came back to the sender');

  /* ---------- a private message: the transport carries it, the game filters it */
  b.messages.length = 0;
  a.send({ t: 'invite', id: 'Alice', to: 'Bob', mode: 'duel' });
  check('a message addressed to one player crosses intact',
    await until(() => b.messages.some(m => m.t === 'invite' && m.to === 'Bob' && m.mode === 'duel'), 4000),
    JSON.stringify(b.messages.slice(-2)));

  /* ---------- a client that goes away is known to be gone, at once ---------- */
  b.close();
  check('a closed client leaves the presence list at once (this is the `bye`)',
    await until(() => a.peers.size === 0, 5000),
    'A still sees ' + a.peers.size);

  /* ---------- two channels are two lobbies ---------- */
  const far = new SupaClient({ url: url, key: key, channel: channel + '-other', name: 'Carol' });
  let farErr = '';
  try { await far.open(15000); } catch (e) { farErr = e.message; }
  check('a third client can join a different channel', far.joined === true, farErr);
  far.messages.length = 0;
  const c = new SupaClient({ url: url, key: key, channel: channel, name: 'Dave' });
  try { await c.open(15000); } catch (e) { /* the checks below say what happened */ }
  a.send({ t: 'hello', id: 'Alice' });
  await sleep(600);
  check('and a different channel is a different lobby',
    far.joined && far.messages.length === 0 && c.messages.some(m => m.t === 'hello'),
    'the other channel heard ' + far.messages.length + ' message(s)');
  far.close();
  c.close();

  /* ---------- what only the fake can answer ---------- */
  if (fake) {
    const seen = fake.snapshot();
    check('the server saw the joins, the broadcasts and the presence list come and go',
      fake.stats.joins >= 4 && fake.stats.broadcasts >= 3 && fake.stats.presence >= 4 &&
      seen.channels.some(ch => ch.topic === 'realtime:' + channel && ch.clients >= 2),
      JSON.stringify(fake.stats) + ' ' + JSON.stringify(seen));
    /* the URL the game builds is the one the server accepts: with a different key
       it is refused at the upgrade, which is what proves the key travels */
    const wrong = new SupaClient({ url: url, key: 'not-the-key', channel: channel, name: 'Eve' });
    let refused = '';
    try { await wrong.open(4000); } catch (e) { refused = e.message; }
    check('the wrong key is refused (so the game really sends the one it was given)',
      !wrong.joined && fake.stats.refusals > 0, refused || 'a bogus key was accepted');
    wrong.close();
  }

  a.close();
  await sleep(300);
  if (fake) {
    await fake.close();
    console.log('\nThe fake server can be pointed at from a browser for a live two-window test:');
    console.log('  node -e "require(\'./tools/supa-fake.js\').start({port:8788}).then(s=>' +
      'console.log(\'supabase:\'+s.url+\'|\'+s.key))"');
    console.log('then paste that line into the game\'s FRIENDS panel and press CONNECT RELAY.');
  } else {
    console.log('\nThe one-line address for the game\'s FRIENDS panel, and for the build:');
    console.log('  supabase:' + url + '|' + key);
    console.log('  ISLE_SUPABASE_URL=' + url + '  ISLE_SUPABASE_KEY=' + key +
      '  node tools/web-build.js');
  }
  console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nSupabase lobby OK');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('FAIL  ' + (e && e.message ? e.message : e));
  process.exit(1);
});
