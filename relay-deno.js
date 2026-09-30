// ISLE ROYALE - the lobby, for Deno Deploy.
//
//   https://console.deno.com  ->  an organization  ->  Applications  ->  New
//   Playground  ->  drop deno-relay.zip in  ->  Deploy.  That gives a permanent
//   https://<app>.<org>.deno.net with no repository, no terminal, no build step
//   and no machine left switched on.
//
//   (Not "+ New App": that one wants a GitHub repository and a framework preset
//   with an install command and a build command. A playground is the browser-only
//   way in, and deno.json next to this file names the entrypoint and the runtime,
//   so there is nothing to fill in by hand.)
//
// It is the same relay as lobby-server.js - rooms, names, `to`-addressed private
// messages, a bye when a socket dies - written for Deno's server so it can run
// where a Node process cannot. The game dials it as
//
//   wss://<app>.<org>.deno.net/isle
//
// What this file does NOT do is serve the game: Deno Deploy runs a script, and
// the models are ~30 MB. The game goes on any file host (see tools/web-build.js
// and DEPLOY-ONLINE.md), and its invite link carries the relay in it -
// ?relay=wss%3A%2F%2F<app>.<org>.deno.net%2Fisle - so a friend who opens that link
// lands in the lobby with nothing to type.
//
// The wire protocol is the one in FRIENDS-NET.md, and it is deliberately the
// same as the Node relay's:
//
//   {t:'hello', id}                       I am here (the relay only reads `id`)
//   {t:'presence', id, party[], mode, ...} what I look like, fanned out
//   {t:'invite'|'join'|'joinok'|'joinno'}  lobby business, fanned out
//   {t:'fask'|'facc'|'fdec'|'funf'}        friend requests, fanned out
//   anything with a `to`                   delivered to that player only
//   {t:'bye', id}                          what the relay says when a socket dies
const MAX_FRAME = 1 << 20;      // a presence packet is ~100 bytes; 1 MB is a hard stop
const DEAD_MS = 180000;         // three minutes of silence: the socket is gone. Kept
                                // long on purpose - a background tab announces about
                                // once a minute, and that is a live player.
/* How long a socket gets to say who it is. A connection that opens here and then
   never introduces itself is not a player: something between the browser and this
   relay ate the handshake, and leaving it in the room makes it count as somebody
   who is online but silent, which is what a filter or a proxy looks like. */
const HELLO_MS = 20000;
const DEFAULT_ROOM = 'isle';

const rooms = new Map();        // room name -> { sockets: Set<WebSocket>, seen: number }
const clients = new Map();      // socket -> { room, name, at }

function cleanRoom(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  return s || DEFAULT_ROOM;
}
function roomFor(name) {
  let room = rooms.get(name);
  if (!room) { room = { sockets: new Set(), seen: 0 }; rooms.set(name, room); }
  return room;
}
function send(socket, text) {
  try { socket.send(text); } catch (e) { /* gone */ }
}
function fanOut(room, text, from) {
  for (const socket of room.sockets) if (socket !== from) send(socket, text);
}
function status() {
  const out = { rooms: [], clients: 0 };
  for (const [name, room] of rooms) {
    out.rooms.push({ room: name, clients: room.sockets.size, seen: room.seen });
    out.clients += room.sockets.size;
  }
  return out;
}

function upgrade(request, roomName) {
  const { socket, response } = Deno.upgradeWebSocket(request);
  const room = roomFor(roomName);

  socket.onopen = () => {
    room.sockets.add(socket);
    const me = { room: roomName, name: '', at: Date.now(), helloTimer: 0 };
    clients.set(socket, me);
    /* The greeting: the relay saying "yes, I am here". A socket that opens here
       but whose answer never reaches the browser - a filter or a proxy eating the
       upgrade - is otherwise indistinguishable from a slow relay. */
    send(socket, JSON.stringify({ t: 'welcome', id: 'relay', room: roomName, at: Date.now() }));
    /* ...and a socket that never introduces itself is a broken connection rather
       than a player, so it is closed with a reason instead of being counted as
       somebody online for the next three minutes. */
    me.helloTimer = setTimeout(() => {
      if (me.name) return;
      try { socket.close(4001, 'no hello'); } catch (e) { /* gone */ }
    }, HELLO_MS);
  };

  socket.onmessage = (event) => {
    const me = clients.get(socket);
    if (!me) return;
    me.at = Date.now();
    const text = typeof event.data === 'string' ? event.data : '';
    if (text.length > MAX_FRAME) {
      try { socket.close(1009, 'too big'); } catch (e) { /* gone */ }
      return;
    }
    room.seen++;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { /* not JSON: fan it out untouched */ }
    if (parsed) {
      /* the name is remembered for one reason: so a drop can be announced as a
         player instead of as a socket nobody can identify */
      if (parsed.t === 'hello' && typeof parsed.id === 'string') {
        me.name = parsed.id.slice(0, 24);
        clearTimeout(me.helloTimer);
        /* Two players with the same name are invisible to each other: the game
           keys everything on the name, so each one's messages look like its own
           echo and are dropped. Nothing else can notice that, so the relay says
           it - to both of them. */
        for (const other of room.sockets) {
          if (other === socket) continue;
          const rec = clients.get(other);
          if (!rec || !rec.name) continue;
          if (rec.name.toLowerCase() !== me.name.toLowerCase()) continue;
          const clash = JSON.stringify({ t: 'clash', id: 'relay', name: me.name, room: roomName });
          send(other, clash);
          send(socket, clash);
        }
      }
      /* `to` is honoured here: a private message never needs the whole room */
      if (typeof parsed.to === 'string' && parsed.to) {
        const want = parsed.to.toLowerCase();
        for (const other of room.sockets) {
          const rec = clients.get(other);
          if (other !== socket && rec && rec.name && rec.name.toLowerCase() === want) {
            send(other, text);
          }
        }
        return;
      }
    }
    fanOut(room, text, socket);
  };

  const drop = () => {
    const me = clients.get(socket);
    if (!me) return;
    clearTimeout(me.helloTimer);
    clients.delete(socket);
    room.sockets.delete(socket);
    if (!room.sockets.size) rooms.delete(roomName);
    if (me.name) fanOut(room, JSON.stringify({ t: 'bye', id: me.name, room: roomName }), socket);
  };
  socket.onclose = drop;
  socket.onerror = drop;

  return response;
}

function landing(origin, pathname) {
  const info = status();
  const list = info.rooms.map((r) => '<li>' + r.room + ' - ' + r.clients + ' in it</li>').join('')
    || '<li>nobody yet</li>';
  const room = pathname.replace(/^\/+/, '').split('/')[0] || DEFAULT_ROOM;
  const wire = origin.replace(/^http/, 'ws') + '/' + cleanRoom(room);
  return '<!doctype html><meta charset="utf-8"><title>Isle Royale lobby</title>' +
    '<body style="font:14px/1.6 system-ui;background:#070b0f;color:#e8f4fa;padding:24px">' +
    '<h1 style="font-size:17px;letter-spacing:3px;color:#41e0ff">ISLE ROYALE LOBBY - UP</h1>' +
    '<p>This address is the <b>relay</b>, not the game. In the game, open FRIENDS, paste ' +
    'it into the box under ANOTHER LOBBY, then press CONNECT RELAY:</p>' +
    '<p><code style="color:#9dffc2">' + wire + '</code></p>' +
    '<p>Better: open the invite link somebody sent you - it already carries this in it.</p>' +
    '<p>' + info.clients + ' connected now:</p><ul>' + list + '</ul>' +
    '<p><a style="color:#41e0ff" href="/relay.json">/relay.json</a> - the same numbers, for scripts</p>' +
    '</body>';
}

Deno.serve((request) => {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('GET only', { status: 405 });
  }
  if (url.pathname === '/relay.json') {
    return new Response(JSON.stringify(status()), {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
  const wantsSocket = String(request.headers.get('upgrade') || '').toLowerCase() === 'websocket';
  if (wantsSocket) {
    const first = url.pathname.replace(/^\/+/, '').split('/')[0];
    return upgrade(request, cleanRoom(url.searchParams.get('room') || first));
  }
  return new Response(landing(url.origin, url.pathname), {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
});

/* A socket that went quiet without closing - a phone off the network, a laptop
   lid - is closed by the house after DEAD_MS, which fires the bye above. The
   client's own heartbeat is 4 s, so only a real disappearance reaches this. */
setInterval(() => {
  const cutoff = Date.now() - DEAD_MS;
  for (const [socket, me] of clients) {
    if (me.at < cutoff) {
      try { socket.close(1001, 'idle'); } catch (e) { /* gone */ }
    }
  }
}, 30000);
