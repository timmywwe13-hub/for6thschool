#!/usr/bin/env node
/* =====================================================================
   ISLE ROYALE - the lobby server.

   Run this and the game stops being one page on one machine:

        node lobby-server.js      (then open the printed LAN address on
                                   every device you want to play with)

   It does two jobs, with nothing but node's own `http`, `fs`, `path`,
   `crypto` and `os` - no dependency to install, no build step, exactly
   like the game itself:

     1. static hosting: index.html and every asset next to it (.glb,
        .glb.js sidecars, vendor/GLTFLoader.js, textures) over plain
        HTTP, so a phone or another PC can open the page at all. A
        file:// page cannot fetch() its siblings and cannot reach a
        websocket on another machine, which is why this exists.

     2. the relay: a websocket endpoint at ws://<host>:<port>/<room>
        that fans every client's JSON out to the other clients of the
        same room. That is the whole protocol, on purpose - the game
        already speaks it (`Net.send`), and the room name in the path is
        what keeps two separate lobbies from seeing each other.

        rooms   http://<host>:8787/?room=isle  -> ws://<host>:8787/isle
                the room is the last path segment, or ?room=..., or 'isle'

   The relay understands exactly one message, and only to be helpful:
   `{t:'hello', id:'<name>'}` is remembered per socket, so when a socket
   drops - a phone locking its screen, a laptop closing its lid, a stray
   Ctrl-W - everybody else gets `{t:'bye', id:'<name>'}` at once instead
   of waiting for the client's heartbeat to time that player out.

   Honest limit: this is a lobby relay, not a game server. It carries
   presence, invites, party joins and the format everyone is queuing
   for; the match itself is still simulated locally on every machine,
   which is what `Teams.matchPlan()` builds the squad from.

   On the name: this file is deliberately NOT `server.js`. Some hosts watch
   for a server entrypoint by filename - server.{js,cjs,mjs,ts,cts,mts} in
   the project root or src/ - and when they find one they stop serving the
   folder as a web site and try to boot it as the whole application, which
   wants either a listen() call at module scope or a default export that is
   a handler. This file has neither (it listens only when it is the process
   that was started, and it exports `start()` for the scenarios), so the
   folder stopped deploying as a plain static site - every request answered
   500 with "Invalid export found in module server.mjs". Kept out of that
   name, it deploys as static files again. See DEPLOY-ONLINE.md.
   ===================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_ROOM = 'isle';
const ROOT = __dirname;
/* 1 MB per frame is far more than a presence packet needs, and it is a
   hard stop on a client that tries to feed the relay a 4 GB "message". */
const MAX_FRAME = 1 << 20;
const PING_MS = 20000;
const DEAD_MS = 45000;
/* How long a socket gets to say who it is. A connection that opens here and then
   never introduces itself is not a player: something between the browser and this
   relay ate the handshake, and leaving it in the room makes it count as somebody
   who is online but silent for minutes. */
const HELLO_MS = 20000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.zip': 'application/zip',
  '.ps1': 'text/plain; charset=utf-8'
};

/* ---------------- rooms ----------------
   A room is a set of sockets. `name` is only ever set from a `hello`, and
   only so that a drop can be announced as that player instead of as a
   socket nobody can identify. */
function cleanRoom(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  return s || DEFAULT_ROOM;
}

/* ---------------- websocket framing (RFC 6455) ----------------
   The handshake is the sha1 of the client key plus the magic GUID; a
   frame arriving from a client is always masked and a frame going out
   never is. Only what this relay needs is here: text (fragmented or
   not), ping, pong and close. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

function frame(opcode, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = buf.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;                    // FIN + opcode
  return Buffer.concat([head, buf]);
}

/* A close frame with a code and a reason, because 0x8 with no body says nothing:
   the player's end gets code 1005 and cannot tell a goodbye from a refusal. The
   codes used here are 4000-range (application defined) so they cannot be
   mistaken for a standard one. */
function closeFrame(code, reason) {
  const why = Buffer.from(String(reason || ''), 'utf8');
  const body = Buffer.alloc(2 + why.length);
  body.writeUInt16BE(code, 0);
  why.copy(body, 2);
  return frame(0x8, body);
}

/* One client's byte stream -> whole messages. The leftover bytes stay on
   the client so a frame split across two TCP reads is simply finished on
   the next one. */
function readFrames(client, chunk, onMessage) {
  client.buf = client.buf && client.buf.length ? Buffer.concat([client.buf, chunk]) : chunk;
  for (;;) {
    const b = client.buf;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return;
      const big = b.readBigUInt64BE(off);
      if (big > BigInt(MAX_FRAME)) { client.socket.destroy(); return; }
      len = Number(big); off += 8;
    }
    if (len > MAX_FRAME) { client.socket.destroy(); return; }
    if (masked) off += 4;
    if (b.length < off + len) return;
    let payload = b.subarray(off, off + len);
    if (masked) {
      const mask = b.subarray(off - 4, off);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    client.buf = b.subarray(off + len);
    client.alive = Date.now();
    if (opcode === 0x8) { onMessage(client, { close: true }); return; }
    if (opcode === 0x9) {                                  // ping -> pong
      try { client.socket.write(frame(0xA, payload)); } catch (e) { /* gone */ }
      continue;
    }
    if (opcode === 0xA) continue;                          // pong is the ack
    if (opcode === 0x1 || opcode === 0x2) {
      if (client.partial) client.socket.destroy();          // a new message mid-fragment
      client.partial = payload;
      client.partialOp = opcode;
    } else if (opcode === 0x0 && client.partial) {
      client.partial = Buffer.concat([client.partial, payload]);
      if (client.partial.length > MAX_FRAME) { client.socket.destroy(); return; }
    } else {
      continue;
    }
    if (fin) {
      const whole = client.partial;
      const op = client.partialOp;
      client.partial = null;
      client.partialOp = 0;
      if (op === 0x1) onMessage(client, { text: whole.toString('utf8') });
    }
    if (!client.buf || client.buf.length === 0) return;
  }
}


/* ---------------- static hosting ---------------- */
/* Everything is served from the folder this file sits in, and nothing
   outside it: the resolved path has to stay under ROOT or the request is
   refused, which is what stops /../../ from reading the disk. */
function safeFile(urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && full.indexOf(ROOT + path.sep) !== 0) return null;
  return full;
}

function sendFile(full, res, quiet) {
  fs.stat(full, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      if (!quiet) console.log('  404 ' + path.relative(ROOT, full));
      return;
    }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (!quiet && st.size > 1 << 20) console.log('  sent ' + path.relative(ROOT, full) +
      ' (' + (st.size / 1048576).toFixed(1) + ' MB)');
    const stream = fs.createReadStream(full);
    stream.on('error', function () { try { res.end(); } catch (e) { /* gone */ } });
    stream.pipe(res);
  });
}

function serveStatic(req, res, quiet) {
  const url = new URL(req.url, 'http://x');
  /* a browser that insists on asking anyway gets a quiet "nothing here"
     rather than a red 404 in its console */
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'Content-Length': 0 });
    res.end();
    return;
  }
  /* ?room=CODE is the shareable link: the game reads it on boot, so the
     joiner only has to press CONNECT. */
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return sendFile(path.join(ROOT, 'index.html'), res, quiet);
  }
  const full = safeFile(url.pathname);
  if (!full) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('outside the game folder');
    if (!quiet) console.log('  refused ' + req.url + ' (outside the folder)');
    return;
  }
  sendFile(full, res, quiet);
}


/* ---------------- the server ---------------- */
function start(opts) {
  opts = opts || {};
  const quiet = !!opts.quiet;
  const rooms = new Map();

  const server = http.createServer(function (req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('GET only');
      return;
    }
    if (new URL(req.url, 'http://x').pathname === '/relay.json') {
      /* a tiny status page, so "is the relay up?" is a browser question */
      const out = { rooms: [], clients: 0 };
      rooms.forEach(function (room) {
        out.rooms.push({ room: room.name, clients: room.sockets.size, seen: room.seen });
        out.clients += room.sockets.size;
      });
      const body = JSON.stringify(out, null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    serveStatic(req, res, quiet);
  });

  function send(client, wire) {
    try { client.socket.write(frame(0x1, wire)); } catch (e) { /* gone */ }
  }
  function broadcast(room, payload, from) {
    const wire = typeof payload === 'string' ? payload : JSON.stringify(payload);
    room.sockets.forEach(function (other) {
      if (other !== from) send(other, wire);
    });
  }

  /* every client: { socket, room, name, buf, partial, partialOp, alive, ping } */
  server.on('upgrade', function (req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://x');
    /* the room is the path (/isle) or ?room=isle, whichever is there */
    const roomName = cleanRoom(url.searchParams.get('room') ||
      decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    let room = rooms.get(roomName);
    if (!room) { room = { name: roomName, sockets: new Set(), seen: 0 }; rooms.set(roomName, room); }

    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
    socket.setNoDelay(true);

    const client = { socket: socket, room: room, name: '',
                     buf: null, partial: null, partialOp: 0, alive: Date.now(), ping: 0,
                     helloTimer: 0 };
    room.sockets.add(client);
    if (!quiet) console.log('  + ' + room.name + '   (' + room.sockets.size + ' in room)');

    /* The greeting. A socket that opens here but whose answer never reaches the
       browser - a filter or a proxy eating the upgrade - is otherwise
       indistinguishable from a slow relay, and the game has no way to tell the
       player which of the two it is. This is the relay saying "yes, I am here". */
    send(client, JSON.stringify({ t: 'welcome', id: 'relay', room: room.name, at: Date.now() }));

    /* ...and the flip side: a socket that never says hello is not somebody who is
       online, it is a broken connection, so it is closed rather than left sitting
       in the room for the DEAD_MS sweep to find. */
    client.helloTimer = setTimeout(function () {
      if (client.name) return;
      try { socket.write(closeFrame(4001, 'no hello')); } catch (e) { /* gone */ }
      try { socket.destroy(); } catch (e) { /* gone */ }
    }, HELLO_MS);
    if (client.helloTimer.unref) client.helloTimer.unref();

    let dropped = false;
    function drop() {
      if (dropped) return;
      dropped = true;
      clearInterval(client.ping);
      clearTimeout(client.helloTimer);
      room.sockets.delete(client);
      if (!room.sockets.size) rooms.delete(room.name);
      /* the one thing the relay is allowed to say on its own: the name it
         learned from this socket's hello is gone */
      if (client.name) broadcast(room, { t: 'bye', id: client.name, room: room.name }, client);
      if (!quiet) console.log('  - ' + room.name + '   ' + (client.name || 'unnamed') +
        '   (' + room.sockets.size + ' in room)');
    }

    function onMessage(c, msg) {
      if (msg.close) {
        try { c.socket.end(frame(0x8, '')); } catch (e) { /* gone */ }
        drop();
        return;
      }
      const text = msg.text || '';
      room.seen++;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { /* not JSON: fan it out untouched */ }
      if (parsed) {
        /* remember the name just so a drop can be announced as a player */
        if (parsed.t === 'hello' && typeof parsed.id === 'string') {
          c.name = parsed.id.slice(0, 24);
          clearTimeout(c.helloTimer);
          /* Two players with the same name are invisible to each other: the game
             keys everything on the name, so each one's messages look like its own
             echo and are dropped. Nothing else can notice that, so the relay says
             it - to both of them. */
          room.sockets.forEach(function (other) {
            if (other === c || !other.name) return;
            if (String(other.name).toLowerCase() !== c.name.toLowerCase()) return;
            const clash = JSON.stringify({ t: 'clash', id: 'relay', name: c.name, room: room.name });
            send(other, clash);
            send(c, clash);
          });
        }
        /* `to` is honoured here: a private message never needs the whole
           room, and an untargeted one is the public presence broadcast */
        if (typeof parsed.to === 'string' && parsed.to) {
          const wire = JSON.stringify(parsed);
          room.sockets.forEach(function (other) {
            if (other !== c && other.name &&
                String(other.name).toLowerCase() === parsed.to.toLowerCase()) send(other, wire);
          });
          return;
        }
      }
      broadcast(room, text, client);
    }

    socket.on('data', function (chunk) { readFrames(client, chunk, onMessage); });
    socket.on('error', drop);
    socket.on('close', drop);
    socket.on('end', drop);
    client.ping = setInterval(function () {
      if (Date.now() - client.alive > DEAD_MS) { socket.destroy(); return; }
      try { socket.write(frame(0x9, '')); } catch (e) { socket.destroy(); }
    }, PING_MS);
    if (client.ping.unref) client.ping.unref();
  });

  return new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(opts.port === undefined ? DEFAULT_PORT : opts.port,
      opts.host || '0.0.0.0', function () {
        const port = server.address().port;
        const lan = [];
        const ifaces = os.networkInterfaces();
        for (const key in ifaces) {
          const list = ifaces[key] || [];
          for (let i = 0; i < list.length; i++) {
            if (list[i].family === 'IPv4' && !list[i].internal) {
              lan.push('http://' + list[i].address + ':' + port + '/');
            }
          }
        }
        const room = cleanRoom(opts.room || DEFAULT_ROOM);
        resolve({
          server: server,
          port: port,
          room: room,
          url: 'http://127.0.0.1:' + port + '/',
          lan: lan,
          rooms: rooms,
          wsUrl: function (want) { return 'ws://127.0.0.1:' + port + '/' + cleanRoom(want || room); },
          close: function () {
            rooms.forEach(function (r) {
              r.sockets.forEach(function (c) { try { c.socket.destroy(); } catch (e) { /* gone */ } });
            });
            rooms.clear();
            return new Promise(function (done) { server.close(function () { done(); }); });
          }
        });
      });
  });
}

module.exports = {
  start: start,
  /* The websocket framing, for the tools that have to speak to a game rather
     than host one: tools/supa-fake.js is a Supabase Realtime server for the
     scenario suite and for tools/supa-check.js, and the server side of RFC 6455
     is the same there as here - so there is one copy of it, in this file. */
  frame: frame,
  closeFrame: closeFrame,
  acceptKey: acceptKey,
  readFrames: readFrames,
  MAX_FRAME: MAX_FRAME
};

/* ---------------- command line ---------------- */
function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, room: DEFAULT_ROOM, host: '0.0.0.0', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--room' || a === '-r') out.room = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (/^\d+$/.test(a)) out.port = Number(a);
  }
  if (!(out.port >= 0 && out.port < 65536)) out.port = DEFAULT_PORT;
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Isle Royale lobby server\n' +
      '  node lobby-server.js [--port 8787] [--room isle] [--host 0.0.0.0]\n\n' +
      'Open the printed link on every device, then press CONNECT in FRIENDS.');
    process.exit(0);
  }
  start(args).then(function (srv) {
    console.log('');
    console.log('  ISLE ROYALE  -  lobby server up');
    console.log('  ------------------------------------------------');
    console.log('  this machine  ' + srv.url);
    srv.lan.forEach(function (u) { console.log('  on your LAN   ' + u + '?room=' + srv.room); });
    console.log('  room          ' + srv.room + '   (ws://' + '...:' + srv.port + '/' + srv.room + ')');
    console.log('  status        ' + srv.url + 'relay.json');
    console.log('  ------------------------------------------------');
    console.log('  Open a link above on every device you want to play with,');
    console.log('  give each one a different player name, then press CONNECT');
    console.log('  in FRIENDS. Ctrl-C stops the server.');
    console.log('');
  }).catch(function (e) {
    console.error('could not start the lobby server: ' + e.message);
    if (e.code === 'EADDRINUSE') console.error('port ' + args.port + ' is taken - try  node lobby-server.js --port 8788');
    process.exit(1);
  });
}

