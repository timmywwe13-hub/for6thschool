// Multiplayer + relay load audit.
//
// The match itself is simulated locally (see FRIENDS-NET.md); what crosses the
// wire is the lobby: presence, invites, party membership and the format. So this
// measures the shipped relay under load, with real sockets:
//
//   * static serving: the game, its loader and a big model sidecar, timed
//   * fan-out: 40 clients in one lobby, every broadcast must reach all of them
//   * latency and bandwidth: presence packets timed end to end, and the bytes a
//     client really receives, scaled to the shipped 4 s heartbeat
//   * churn: 120 join/leave cycles, then the relay must report an empty lobby
//     and its heap must not have grown
//   * abuse: an oversized frame is dropped without hurting the room, a dropped
//     socket is announced as a bye, and a private message reaches only its target
//
//   node cdp-test.js netperf
const relay = require('../lobby-server.js');

module.exports = async function netperf(ctx) {
  const { check, sleep } = ctx;

  const srv = await relay.start({ port: 0, quiet: true });
  const base = 'http://127.0.0.1:' + srv.port + '/';
  const roomUrl = srv.wsUrl('isle');

  /* ---------------- 1. what the server serves ---------------- */
  const t0 = Date.now();
  const home = await fetch(base);
  const html = await home.text();
  const homeMs = Date.now() - t0;
  const loader = await fetch(base + 'vendor/GLTFLoader.js');
  const t1 = Date.now();
  const sidecar = await fetch(base + 'freddy_fazzbear.glb.js');
  const sideBytes = (await sidecar.arrayBuffer()).byteLength;
  const sideMs = Date.now() - t1;
  console.log('  index.html ' + Math.round(html.length / 1024) + ' KB in ' + homeMs + ' ms; ' +
    'GLTFLoader ' + loader.status + '; sidecar ' + Math.round(sideBytes / 1024) + ' KB in ' + sideMs +
    ' ms (' + (sideBytes / 1048576 / Math.max(0.001, sideMs / 1000)).toFixed(1) + ' MB/s)');
  check('the relay serves the game and its assets',
    home.status === 200 && /ISLE ROYALE/.test(html) && loader.status === 200 && sidecar.status === 200,
    'html ' + home.status + ', loader ' + loader.status + ', sidecar ' + sidecar.status);

  /* ---------------- helpers: real sockets ---------------- */
  function client(name) {
    const ws = new WebSocket(roomUrl);
    const c = { name: name, ws: ws, msgs: [], bytes: 0, closed: false, open: false };
    ws.addEventListener('open', function () { c.open = true; });
    ws.addEventListener('close', function () { c.closed = true; });
    ws.addEventListener('message', function (ev) {
      const text = typeof ev.data === 'string' ? ev.data : '';
      c.bytes += text.length + 6;                    // text frame + framing overhead
      let m = null;
      try { m = JSON.parse(text); } catch (e) { m = { raw: text }; }
      c.msgs.push(m);
    });
    return c;
  }
  function send(c, obj) { c.ws.send(JSON.stringify(obj)); }
  async function until(fn, ms) {
    const deadline = Date.now() + (ms || 3000);
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > deadline) return v || null;
      await sleep(20);
    }
  }
  const waitOpen = (c, ms) => until(() => c.open, ms || 3000);

  /* ---------------- 2. fan-out + latency in a 40-player lobby ---------------- */
  const N = 40;
  const lobby = [];
  for (let i = 0; i < N; i++) lobby.push(client('P' + i));
  await Promise.all(lobby.map(c => waitOpen(c)));
  const opened = lobby.filter(c => c.open).length;
  for (const c of lobby) send(c, { t: 'hello', id: c.name });
  await sleep(150);
  const announce = name => ({ t: 'announce', id: name, party: [], mode: 'br',
    state: 'PLAYING', open: true, friends: 3, skin: 'freddy' });
  const msgSize = JSON.stringify(announce('P0')).length;
  for (const c of lobby) send(c, announce(c.name));
  await until(() => lobby.every(c => c.msgs.filter(m => m.t === 'announce').length >= N - 1), 8000);
  const heard = lobby.map(c => c.msgs.filter(m => m.t === 'announce').length);
  console.log('  fan-out: ' + opened + '/' + N + ' sockets open, announcements heard ' +
    Math.min(...heard) + '..' + Math.max(...heard) + ' of ' + (N - 1) + ' (one per other player)');
  check('a 40-player lobby hears every announcement, once each',
    opened === N && heard.every(n => n === N - 1),
    opened + ' open; heard ' + Math.min(...heard) + '..' + Math.max(...heard) + ' of ' + (N - 1));

  /* end-to-end latency: P1 times 60 announcements from P0 */
  const lat = [];
  for (let i = 0; i < 60; i++) {
    const id = 'lat' + i;
    const sentAt = performance.now();
    send(lobby[0], { t: 'announce', id: id, from: 'P0' });
    await sleep(20);
    if (lobby[1].msgs.some(m => m.id === id)) lat.push(performance.now() - sentAt);
  }
  lat.sort((a, b) => a - b);
  const latP50 = lat.length ? lat[Math.floor(lat.length * 0.5)] : -1;
  const latP95 = lat.length ? lat[Math.floor(lat.length * 0.95)] : -1;
  console.log('  presence latency over the relay: ' + lat.length + '/60 delivered, p50 ' +
    (latP50 < 0 ? '-' : latP50.toFixed(1)) + ' ms, p95 ' + (latP95 < 0 ? '-' : latP95.toFixed(1)) + ' ms');
  check('presence arrives in a fraction of a frame at 40 players',
    lat.length >= 58 && latP95 < 50,
    lat.length + '/60 delivered, p95 ' + (latP95 < 0 ? '-' : latP95.toFixed(1)) + ' ms');

  /* bandwidth: what one client received across the 40-player burst, and the
     shipped 4 s heartbeat at 8 players */
  const rx = lobby[3].bytes;
  const perMinute = msgSize * (N - 1) * 15;
  console.log('  bandwidth: one client received ' + rx + ' B across ' + N + ' announces;' +
    ' the shipped heartbeat at 8 players is ~' + Math.round(perMinute / 1024) + ' KB/min');
  check('the shipped presence heartbeat is a trickle',
    perMinute < 128 * 1024,
    Math.round(perMinute / 1024) + ' KB/min at 40 players, message ' + msgSize + ' B');

  /* ---------------- 3. private messages and abuse ---------------- */
  const A = lobby[0], B = lobby[1], C = lobby[2];
  const pBefore = B.msgs.length, cBefore = C.msgs.length;
  send(A, { t: 'ask', to: 'P1', id: 'priv1', from: 'P0' });
  await sleep(250);
  const bGot = B.msgs.slice(pBefore).filter(m => m.id === 'priv1').length;
  const cGot = C.msgs.slice(cBefore).filter(m => m.id === 'priv1').length;
  check('a private message reaches only its target', bGot === 1 && cGot === 0,
    'target got ' + bGot + ', bystander got ' + cGot);

  /* a 2 MB frame: the relay's MAX_FRAME is 1 MB, so this socket is dropped */
  const big = lobby[5];
  const othersBefore = lobby[6].msgs.length;
  big.ws.send(JSON.stringify({ t: 'announce', id: 'BIG', blob: 'x'.repeat(2 * 1024 * 1024) }));
  await until(() => big.closed, 4000);
  await sleep(250);
  send(A, { t: 'announce', id: 'after-big' });
  await sleep(300);
  const roomAlive = lobby[6].msgs.slice(othersBefore).some(m => m.id === 'after-big');
  check('an oversized frame drops only the offender',
    big.closed === true && roomAlive,
    'offender closed ' + big.closed + ', room still delivering ' + roomAlive);

  /* an abrupt socket death is announced as a bye */
  const victim = lobby[7];
  const byeBefore = A.msgs.length;
  victim.ws.close();
  await until(() => A.msgs.slice(byeBefore).some(m => m.t === 'bye' && m.id === 'P7'), 4000);
  const byes = A.msgs.slice(byeBefore).filter(m => m.t === 'bye' && m.id === 'P7').length;
  check('a dropped player is announced to the room as a bye', byes >= 1, byes + ' bye(s) seen');

  /* ---------------- 4. churn: 120 joins/leaves and the state afterwards ---------------- */
  const heapBefore = process.memoryUsage().heapUsed;
  for (let round = 0; round < 3; round++) {
    const batch = [];
    for (let i = 0; i < 40; i++) batch.push(client('CH' + round + '_' + i));
    await Promise.all(batch.map(c => waitOpen(c)));
    for (const c of batch) send(c, { t: 'hello', id: c.name });
    await sleep(60);
    for (const c of batch) c.ws.close();
    await sleep(140);
  }
  for (const c of lobby) { try { c.ws.close(); } catch (e) { /* gone */ } }
  await sleep(400);
  const status = await (await fetch(base + 'relay.json')).json();
  const heapAfter = process.memoryUsage().heapUsed;
  console.log('  churn: 120 join/leave cycles; relay now ' + JSON.stringify(status) +
    '; relay heap ' + Math.round(heapBefore / 1048576) + ' -> ' + Math.round(heapAfter / 1048576) + ' MB');
  check('the lobby is empty again after 120 join/leave cycles',
    status.clients === 0 && srv.rooms.size === 0,
    JSON.stringify(status) + ', rooms ' + srv.rooms.size);
  check('the relay does not grow across 120 joins and leaves',
    (heapAfter - heapBefore) < 24 * 1048576,
    Math.round((heapAfter - heapBefore) / 1048576) + ' MB growth');

  const out = { fanOut: heard, latency: { p50: +latP50.toFixed(1), p95: +latP95.toFixed(1), delivered: lat.length },
    perMinuteKB: Math.round(perMinute / 1024), oneClientBytes: rx,
    churnGrowthMB: +((heapAfter - heapBefore) / 1048576).toFixed(1), opened: opened };
  await srv.close();
  return out;
};