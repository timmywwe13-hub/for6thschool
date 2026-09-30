// Protocol check for relay-deno.js - the lobby as it runs on Deno Deploy.
//
//   deno run --allow-net relay-deno.js      # in one window, listens on :8000
//   node tools/relay-deno-check.js          # in another, then Ctrl-C the first
//
// It asserts what the lobby is *for*: a room fanning messages out to its players,
// a second room seeing none of them, a message with `to` reaching only its target,
// a dead socket announced as {t:'bye', id}, /relay.json counting all of it, and
// the landing page telling a visitor the address the game wants.
const assert = require('assert');
const base = 'http://127.0.0.1:8000/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function () {
  const home = await fetch(base);
  const text = await home.text();
  assert.strictEqual(home.status, 200, 'landing status');
  assert.ok(/ISLE ROYALE LOBBY/.test(text), 'landing page names the lobby');
  /* on a https host this line says wss:// - it is derived from the origin, so a
     local http run prints ws:// and Deno Deploy prints wss:// */
  const wire = base.replace(/^http/, 'ws') + 'isle';
  assert.ok(text.indexOf(wire) >= 0, 'landing prints the wire address (' + wire + ')');
  console.log('PASS  the relay serves a landing page that names its own ws address');

  const posted = await fetch(base, { method: 'POST' });
  assert.strictEqual(posted.status, 405, 'POST is refused');
  console.log('PASS  anything but GET is refused');

  const empty = await (await fetch(base + 'relay.json')).json();
  assert.strictEqual(empty.clients, 0, 'idle lobby');
  console.log('PASS  /relay.json reports an empty lobby: ' + JSON.stringify(empty));

  const open = url => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('socket error ' + url));
  });
  const wait = (ws, want) => new Promise(resolve => {
    const on = ev => {
      const m = JSON.parse(ev.data);
      if (m.t === want.t && (!want.id || m.id === want.id)) {
        ws.removeEventListener('message', on);
        resolve(m);
      }
    };
    ws.addEventListener('message', on);
  });

  const a = await open('ws://127.0.0.1:8000/isle');
  const b = await open('ws://127.0.0.1:8000/isle');
  const far = await open('ws://127.0.0.1:8000/other');

  a.send(JSON.stringify({ t: 'hello', id: 'Alice' }));
  b.send(JSON.stringify({ t: 'hello', id: 'Bob' }));
  far.send(JSON.stringify({ t: 'hello', id: 'Carol' }));

  const heard = wait(b, { t: 'presence', id: 'Alice' });
  a.send(JSON.stringify({ t: 'presence', id: 'Alice', mode: 'duo', state: 'MENU' }));
  assert.strictEqual((await heard).mode, 'duo', 'Bob hears Alice');
  console.log('PASS  a message in the room reaches the other player');

  let leaked = 0;
  far.addEventListener('message', ev => { if (JSON.parse(ev.data).id === 'Alice') leaked++; });
  a.send(JSON.stringify({ t: 'presence', id: 'Alice', mode: 'duo' }));
  await sleep(300);
  assert.strictEqual(leaked, 0, 'the other room must not see it');
  console.log('PASS  a different room is a different lobby');

  let forOthers = 0;
  b.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.to === 'Alice') forOthers++;
  });
  const privateMsg = wait(a, { t: 'invite', id: 'Bob' });
  b.send(JSON.stringify({ t: 'invite', id: 'Bob', to: 'Alice', mode: 'duel' }));
  assert.strictEqual((await privateMsg).mode, 'duel', 'the target gets it');
  await sleep(300);
  assert.strictEqual(forOthers, 0, 'nobody else does');
  console.log('PASS  a message addressed to one player reaches only that player');

  const status = await (await fetch(base + 'relay.json')).json();
  assert.strictEqual(status.clients, 3, 'three clients');
  assert.ok(status.rooms.some(r => r.room === 'isle' && r.clients === 2 && r.seen > 0),
    JSON.stringify(status));
  console.log('PASS  /relay.json counts rooms and clients: ' + JSON.stringify(status));

  const bye = wait(b, { t: 'bye', id: 'Alice' });
  a.close();
  assert.strictEqual((await bye).id, 'Alice', 'the bye carries the name');
  console.log('PASS  a closed socket is announced as that player, with no timeout');

  b.close();
  far.close();
  await sleep(400);
  const after = await (await fetch(base + 'relay.json')).json();
  assert.strictEqual(after.clients, 0, 'empty again: ' + JSON.stringify(after));
  assert.strictEqual(after.rooms.length, 0, 'and no empty rooms left behind');
  console.log('PASS  the lobby is empty again when everybody leaves');
  console.log('\nrelay-deno OK');
  process.exit(0);
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });
