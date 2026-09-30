// The Supabase lobby, from Node - the same protocol as `connectSupabase` in
// index.html, written small. It is what tools/supa-check.js checks a project
// with, and it is deliberately a second implementation of the wire rather than a
// call into the game: the point of the check is that a real project answers the
// protocol the game speaks.
//
//   const cli = new SupaClient({ url, key, channel, name });
//   await cli.open();                 // socket open AND channel joined
//   cli.on = function (msg) {...}     // every game message that arrives
//   cli.send({ t: 'hello', id: cli.name });
//   await cli.close();
//
// Node 22 has a global WebSocket, so this needs nothing installed.
'use strict';

class SupaClient {
  constructor(opts) {
    opts = opts || {};
    this.name = opts.name || 'Recruit';
    this.channel = opts.channel || 'isle';
    this.topic = 'realtime:' + this.channel;
    /* one presence key per connection, exactly like the game's - two clients on
       one name are two entries, which is what makes a clash visible */
    this.key = 'c' + Math.random().toString(36).slice(2, 10);
    this.url = String(opts.url || '').replace(/^http/, 'ws').replace(/\/+$/, '') +
      '/realtime/v1/websocket?apikey=' + encodeURIComponent(opts.key || '') + '&vsn=1.0.0';
    this.ws = null;
    this.ref = 0;
    this.joinRef = 0;
    this.joined = false;
    this.heart = 0;
    this.peers = new Map();      // presence key -> the name inside it
    this.messages = [];          // every game message that arrived
    this.systems = [];           // channel-level 'system' notices
    this.on = null;              // (msg) => void
    this.error = '';
  }

  push(event, payload, join, topic) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    const msg = { topic: topic || this.topic, event: event, payload: payload,
                  ref: String(++this.ref) };
    msg.join_ref = (join && this.joinRef) ? String(this.joinRef) : null;
    try { this.ws.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
  }

  /* the game's own message set, over a broadcast - `event:'isle'`, exactly as
     index.html sends it */
  send(msg) {
    if (!this.joined) return false;
    return this.push('broadcast', { type: 'broadcast', event: 'isle', payload: msg }, true);
  }

  track() {
    return this.push('presence', { type: 'presence', event: 'track',
                                   payload: { id: this.name } }, true);
  }

  untrack() {
    return this.push('presence', { type: 'presence', event: 'untrack', payload: {} }, true);
  }

  nameIn(entry) {
    const metas = (entry && entry.metas) || [];
    return metas.length ? String(metas[0].id || '') : '';
  }

  receive(m) {
    if (m.event === 'broadcast') {
      const p = m.payload || {};
      if (p.event !== 'isle' || !p.payload || typeof p.payload !== 'object') return;
      this.messages.push(p.payload);
      if (this.on) this.on(p.payload);
      return;
    }
    if (m.event === 'presence_state') {
      this.peers = new Map();
      const state = m.payload || {};
      for (const key in state) {
        const name = this.nameIn(state[key]);
        if (name && key !== this.key) this.peers.set(key, name);
      }
      return;
    }
    if (m.event === 'presence_diff') {
      const d = m.payload || {};
      const joins = d.joins || {};
      const leaves = d.leaves || {};
      for (const key in joins) {
        const name = this.nameIn(joins[key]);
        if (name && key !== this.key) this.peers.set(key, name);
      }
      for (const key in leaves) this.peers.delete(key);
      return;
    }
    if (m.event === 'system') {
      this.systems.push(m.payload || {});
      if (m.payload && m.payload.status && m.payload.status !== 'ok') {
        this.error = String(m.payload.message || m.payload.status);
      }
      return;
    }
    if (m.event === 'phx_error' || m.event === 'phx_close') this.joined = false;
  }

  /* Resolves once the channel is JOINED - not when the socket opens, because a
     broadcast sent in between is dropped by the server with no error at all. */
  open(timeoutMs) {
    const self = this;
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('no answer within ' + (timeoutMs || 15000) + ' ms'));
      }, timeoutMs || 15000);
      const finish = function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(self);
      };
      let ws = null;
      try { ws = new WebSocket(self.url); } catch (e) { finish(e); return; }
      self.ws = ws;
      ws.onerror = function () { finish(new Error('could not reach ' + self.url)); };
      ws.onopen = function () {
        self.joinRef = ++self.ref;
        ws.send(JSON.stringify({
          topic: self.topic, event: 'phx_join', ref: String(self.ref),
          join_ref: String(self.joinRef),
          payload: { config: { broadcast: { ack: false, self: false },
                               presence: { enabled: true, key: self.key },
                               private: false } }
        }));
      };
      ws.onmessage = function (ev) {
        let m = null;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.event === 'phx_reply' && !self.joined && String(m.ref) === String(self.joinRef)) {
          if (!(m.payload && m.payload.status === 'ok')) {
            finish(new Error('the join was refused: ' + JSON.stringify(m.payload || {})));
            return;
          }
          self.joined = true;
          self.track();
          self.heart = setInterval(function () {
            self.push('heartbeat', {}, false, 'phoenix');
          }, 20000);
          if (self.heart.unref) self.heart.unref();
          finish(null);
          return;
        }
        self.receive(m);
      };
      ws.onclose = function (ev) {
        self.joined = false;
        finish(new Error('the socket closed before the channel joined (' +
          ((ev && ev.code) || '?') + (ev && ev.reason ? ' ' + ev.reason : '') + ')'));
      };
    });
  }

  close() {
    if (this.heart) clearInterval(this.heart);
    this.heart = 0;
    if (this.joined) this.untrack();
    this.joined = false;
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
    }
  }
}

module.exports = { SupaClient: SupaClient };
