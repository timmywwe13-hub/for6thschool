// A Supabase Realtime server, for the tests: no account, no internet, no project.
//
// The game's Supabase transport (`connectSupabase` in index.html) speaks
// Supabase's own wire protocol - version 1.0.0, the JSON-object form - which is
// a Phoenix channel in front of a pub/sub. That is small enough to serve here,
// and serving it is what makes the whole transport testable offline:
//
//   * scenarios/supanet.js  boots two real browsers against this and checks what
//                           two devices on a Supabase lobby actually see;
//   * tools/supa-check.js   runs the same protocol from Node, and will happily
//                           point at a REAL project instead (url + key), which
//                           is how a new project gets checked before a deploy.
//
// What it implements, and nothing else:
//
//   phx_join                     -> phx_reply {status:'ok'} then presence_state
//   presence {event:'track'}     -> presence_state to the tracker, presence_diff
//                                   {joins:...} to everybody else
//   presence {event:'untrack'}   -> presence_diff {leaves:...}
//   broadcast                    -> fanned out to the others on the topic
//                                   (self is false: senders never hear their own)
//   heartbeat on topic 'phoenix' -> phx_reply {status:'ok'}
//   phx_leave, or a dead socket  -> presence_diff {leaves:...} to the others
//
// The RFC 6455 side is NOT written again here: `frame`, `acceptKey` and
// `readFrames` are lobby-server.js' own, so the project keeps one websocket
// implementation and the tests exercise it too.
'use strict';

const http = require('http');
const path = require('path');
const relay = require(path.join(__dirname, '..', 'lobby-server.js'));

const DEFAULT_KEY = 'fake-anon-key';
const PING_MS = 20000;
const DEAD_MS = 60000;

function start(opts) {
  opts = opts || {};
  const quiet = !!opts.quiet;
  const KEY = opts.key === undefined ? DEFAULT_KEY : opts.key;
  /* a wrong key is refused at the upgrade, exactly like the real server, so a
     test can prove the game really sent the key it was given */
  const channels = new Map();          // topic -> {topic, clients, presence}
  const stats = { joins: 0, broadcasts: 0, presence: 0, heartbeats: 0, refusals: 0,
                  delivered: 0, dropped: 0, poses: 0 };

  function roomFor(topic) {
    let ch = channels.get(topic);
    if (!ch) { ch = { topic: topic, clients: new Map(), presence: new Map() }; channels.set(topic, ch); }
    return ch;
  }
  function write(socket, obj) {
    if (!socket || socket.destroyed) return;
    try { socket.write(relay.frame(0x1, JSON.stringify(obj))); stats.delivered++; }
    catch (e) { /* gone */ }
  }
  /* one channel message to everybody except `from` (null = everybody) */
  function fanOut(ch, obj, from) {
    const wire = JSON.stringify(obj);
    ch.clients.forEach(function (rec, socket) {
      if (socket === from || socket.destroyed) return;
      try { socket.write(relay.frame(0x1, wire)); stats.delivered++; }
      catch (e) { stats.dropped++; }
    });
  }
  /* the payload shape the real server sends: {key:{metas:[{phx_ref, ...}]}} */
  function entry(key, payload) {
    const meta = { phx_ref: 'ref-' + key };
    for (const k in payload) meta[k] = payload[k];
    const out = {};
    out[key] = { metas: [meta] };
    return out;
  }
  function presenceState(ch) {
    const out = {};
    ch.presence.forEach(function (payload, key) {
      const meta = { phx_ref: 'ref-' + key };
      for (const k in payload) meta[k] = payload[k];
      out[key] = { metas: [meta] };
    });
    return out;
  }
  function presenceDiff(ch, joins, leaves) {
    fanOut(ch, { topic: ch.topic, event: 'presence_diff', ref: null, join_ref: null,
                 payload: { joins: joins || {}, leaves: leaves || {} } }, null);
  }
  function snapshot() {
    const out = { channels: [], clients: 0, presence: 0 };
    channels.forEach(function (ch) {
      out.channels.push({ topic: ch.topic, clients: ch.clients.size, presence: ch.presence.size });
      out.clients += ch.clients.size;
      out.presence += ch.presence.size;
    });
    return out;
  }

  const server = http.createServer(function (req, res) {
    const body = JSON.stringify(Object.assign(snapshot(), { server: 'supa-fake', stats: stats }), null, 2);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  });

  server.on('upgrade', function (req, socket) {
    const key = req.headers['sec-websocket-key'];
    const url = new URL(req.url, 'http://x');
    const wantsSocket = String(req.headers.upgrade || '').toLowerCase() === 'websocket';
    /* the real server upgrades only its own path, and only with its own key, so
       a test can prove the game sent the key it was handed */
    if (!key || !wantsSocket || url.pathname.indexOf('/realtime/v1/websocket') !== 0 ||
        (KEY !== null && url.searchParams.get('apikey') !== KEY)) {
      stats.refusals++;
      try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch (e) { /* gone */ }
      socket.destroy();
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + relay.acceptKey(key) + '\r\n\r\n');
    socket.setNoDelay(true);

    /* one client: {socket, buf, partial, partialOp, alive, topic, key, joinRef} */
    const client = { socket: socket, buf: null, partial: null, partialOp: 0,
                     alive: Date.now(), topic: '', key: '', joinRef: null, ping: 0 };

    let dropped = false;
    function drop() {
      if (dropped) return;
      dropped = true;
      clearInterval(client.ping);
      const ch = channels.get(client.topic);
      if (ch) {
        ch.clients.delete(client.socket);
        if (ch.presence.has(client.key)) {
          ch.presence.delete(client.key);
          /* a socket that died takes its presence with it and the others are told
             at once - this is the game's `bye`, on Supabase */
          presenceDiff(ch, null, { [client.key]: { metas: [{ phx_ref: 'ref-' + client.key }] } });
        }
        if (!ch.clients.size && !ch.presence.size) channels.delete(ch.topic);
      }
      try { socket.destroy(); } catch (e) { /* gone */ }
    }

    function onMessage(c, msg) {
      if (msg.close) { drop(); return; }
      let m = null;
      try { m = JSON.parse(msg.text || ''); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      const topic = String(m.topic || '');
      if (m.event === 'heartbeat') {
        stats.heartbeats++;
        write(c.socket, { topic: topic, event: 'phx_reply', ref: m.ref, join_ref: null,
                          payload: { status: 'ok', response: {} } });
        return;
      }
      const ch = roomFor(topic);
      if (m.event === 'phx_join') {
        c.topic = topic;
        c.joinRef = (m.join_ref === null || m.join_ref === undefined) ? null : String(m.join_ref);
        c.key = String((m.payload && m.payload.config && m.payload.config.presence &&
                        m.payload.config.presence.key) || '') || ('k' + (ch.clients.size + 1));
        c.alive = Date.now();
        if (opts.refuse) {
          stats.refusals++;
          write(c.socket, { topic: topic, event: 'phx_reply', ref: m.ref, join_ref: c.joinRef,
                            payload: { status: 'error', response: { reason: String(opts.refuse) } } });
          return;
        }
        ch.clients.set(c.socket, c);
        stats.joins++;
        write(c.socket, { topic: topic, event: 'phx_reply', ref: m.ref, join_ref: c.joinRef,
                          payload: { status: 'ok', response: { postgres_changes: [] } } });
        /* what the real server sends straight after a join is accepted */
        write(c.socket, { topic: topic, event: 'presence_state', ref: null, join_ref: null,
                          payload: presenceState(ch) });
        if (!quiet) console.log('  + ' + topic + '   (' + ch.clients.size + ' on the channel)');
        return;
      }
      /* everything below needs a joined channel, exactly like the real server */
      if (!ch.clients.has(c.socket)) return;
      c.alive = Date.now();
      if (m.event === 'presence' && m.payload && m.payload.event === 'track') {
        const payload = (m.payload.payload && typeof m.payload.payload === 'object')
          ? m.payload.payload : {};
        ch.presence.set(c.key, payload);
        stats.presence++;
        write(c.socket, { topic: topic, event: 'presence_state', ref: null, join_ref: null,
                          payload: presenceState(ch) });
        presenceDiff(ch, entry(c.key, payload), null);
        return;
      }
      if (m.event === 'presence' && m.payload && m.payload.event === 'untrack') {
        ch.presence.delete(c.key);
        presenceDiff(ch, null, { [c.key]: { metas: [{ phx_ref: 'ref-' + c.key }] } });
        return;
      }
      if (m.event === 'broadcast') {
        const p = m.payload || {};
        stats.broadcasts++;
        /* the game's live-pose stream is counted apart: it is the one message with
           a clock on it, and the lobby scenario asserts on it directly */
        if (p.event === 'isle' && p.payload && p.payload.t === 'pose') stats.poses++;
        /* self is false: a sender never hears its own broadcast, which is the one
           thing the game leans on - its own messages would otherwise arrive as if
           somebody else had sent them */
        fanOut(ch, { topic: topic, event: 'broadcast', ref: null, join_ref: null,
                     payload: { type: 'broadcast', event: p.event, payload: p.payload } },
               c.socket);
        return;
      }
      if (m.event === 'phx_leave') {
        write(c.socket, { topic: topic, event: 'phx_close', ref: m.ref, join_ref: c.joinRef,
                          payload: {} });
        drop();
      }
    }

    socket.on('data', function (chunk) { relay.readFrames(client, chunk, onMessage); });
    socket.on('error', drop);
    socket.on('close', drop);
    socket.on('end', drop);
    client.ping = setInterval(function () {
      if (Date.now() - client.alive > DEAD_MS) { drop(); return; }
      try { socket.write(relay.frame(0x9, '')); } catch (e) { drop(); }
    }, PING_MS);
    if (client.ping.unref) client.ping.unref();
  });

  return new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(opts.port === undefined ? 0 : opts.port, opts.host || '127.0.0.1', function () {
      const port = server.address().port;
      if (!quiet) console.log('  supa-fake up on http://127.0.0.1:' + port +
        '/realtime/v1/websocket?apikey=' + KEY + '&vsn=1.0.0');
      resolve({
        port: port,
        key: KEY,
        /* the game appends /realtime/v1/websocket?apikey=... to this */
        url: 'http://127.0.0.1:' + port,
        stats: stats,
        snapshot: snapshot,
        close: function () {
          channels.forEach(function (ch) {
            ch.clients.forEach(function (rec, s) { try { s.destroy(); } catch (e) { /* gone */ } });
          });
          channels.clear();
          return new Promise(function (done) { server.close(function () { done(); }); });
        }
      });
    });
  });
}

module.exports = { start: start, DEFAULT_KEY: DEFAULT_KEY };
