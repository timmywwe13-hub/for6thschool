// The lobby you can see: other players, drawn, in their own skins.
//
// The transport scenarios (supanet, friendsnet) prove the roster - who is online.
// This one proves the room: everybody the roster knows about is standing on the
// floor as their character, walking where the wire says they are walking, and
// gone when they close the tab. It runs the shipped game in a real browser with a
// third "player" that is a raw client (tools/supa-client.js, the same wire), so a
// pose can be placed at an exact coordinate and the avatar's response measured -
// which is also how "a pose that stops coming puts them back in their seat" gets
// checked without waiting out a timeout.
const http = require('http');
const fs = require('fs');
const path = require('path');
const supaFake = require('../tools/supa-fake.js');
const { SupaClient } = require('../tools/supa-client.js');

module.exports = async function lobby(ctx) {
  const { evaluate, check, sleep, send } = ctx;
  const root = path.resolve(__dirname, '..');

  const fake = await supaFake.start({ port: 0, quiet: true });
  const wire = 'supabase:' + fake.url + '|' + fake.key;

  /* ---------- the game on a plain file host ---------- */
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json',
    '.fbx': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8' };
  const files = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
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
  const link = base + '?room=isle&relay=' + encodeURIComponent(wire);

  /* ---------- helpers ---------- */
  async function evalOn(session, expr) {
    const r = await send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, session);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page eval failed: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  }
  async function until(session, expr, ms) {
    const deadline = Date.now() + (ms || 15000);
    let last = null;
    for (;;) {
      try { last = await evalOn(session, expr); } catch (e) { last = null; }
      if (last) return last;
      if (Date.now() > deadline) return last;
      await sleep(150);
    }
  }
  const booted = session => until(session, `(function () {
    try {
      return !!(typeof App !== 'undefined' && App.state === 'MENU' &&
                document.getElementById('bootLoading').classList.contains('hidden'));
    } catch (e) { return false; }
  })()`, 40000);
  /* one avatar out of the room, by name */
  const avatarOf = (name) => `(function () {
    const rows = Avatar.roster();
    for (let i = 0; i < rows.length; i++) if (rows[i].name.toLowerCase() === '${name.toLowerCase()}') return rows[i];
    return null;
  })()`;

  /* ---------- device one, and the room it opens ---------- */
  await send('Page.navigate', { url: link });
  check('the game boots from a host that only serves files', (await booted(undefined)) === true);
  await evaluate(`(function () { const was = SETTINGS.name; SETTINGS.name = 'Alice';
    Net.rename(was); Modes.paint(); return true; })()`);
  await until(undefined, `Net.kind === 'supa' && Net.sb && Net.sb.joined`, 25000);

  const closed = await evaluate(`(function () {
    return { poseWant: !!Net.poseWant, avatars: Avatar.count() };
  })()`);
  check('nothing is drawn and nothing is published until the room is opened',
    closed.poseWant === false && closed.avatars === 0, JSON.stringify(closed));

  const posesBefore = fake.stats.poses;
  await evaluate(`(function () { document.getElementById('btnLobby').click(); return true; })()`);
  const opened = await until(undefined, `(function () {
    const st = Lobby.state();
    const me = Avatar.onFloor('Alice');
    if (!st.open || !st.gl || !me) return null;
    return { open: st.open, gl: st.gl, mine: me.mine, skin: me.skin,
             avatars: st.walking, poseWant: st.poseWant, hint: st.hint };
  })()`, 25000);
  check('the LOBBY button opens a room with the local player standing in it',
    !!opened && opened.mine === true && opened.skin === 'freddy' && opened.poseWant === true,
    JSON.stringify(opened));
  check('and opening it is what starts the pose stream',
    (await until(undefined, `Net.poseWant === true ? true : null`, 8000)) === true,
    'poses before opening: ' + posesBefore + ', now ' + fake.stats.poses);

  /* the lap: the local player walks, so the stream has something to say even when
     nobody else is in the room */
  const walked = await until(undefined, `(function () {
    const me = ${avatarOf('Alice')};
    return (me && me.moving) ? { x: me.x, z: me.z, moving: me.moving, anim: me.anim } : null;
  })()`, 10000);
  await sleep(1200);
  const walked2 = await evaluate(avatarOf('Alice'));
  const moved = Math.abs(walked2.x - walked.x) + Math.abs(walked2.z - walked.z);
  check('the local player takes a lap, and the local pose drives their legs',
    moved > 0.2 && walked.anim === 'walk',
    'moved ' + moved.toFixed(2) + ' m from (' + walked.x + ',' + walked.z + ') in 1.2 s');
  check('and those poses really left the machine',
    fake.stats.poses > 4, fake.stats.poses + ' pose(s) seen by the server');

  /* ---------- the third player: a raw client, on the same wire ---------- */
  const zoe = new SupaClient({ url: fake.url, key: fake.key, channel: 'isle', name: 'Zoe' });
  let joined = true;
  try { await zoe.open(15000); } catch (e) { joined = false; }
  zoe.send({ t: 'hello', id: 'Zoe' });
  zoe.send({ t: 'presence', id: 'Zoe', friends: 0, party: ['Zoe'], mode: 'trios',
             host: 'Zoe', state: 'MENU', open: true, skin: 'ghost' });
  const walkedIn = await until(undefined, `${avatarOf('Zoe')}`, 20000);
  check('a player who arrives is put in the room',
    joined && !!walkedIn && walkedIn.skin === 'ghost' && walkedIn.mine === false,
    JSON.stringify(walkedIn));
  check('their name tag says what they are queuing for',
    (await evaluate(`(function () { const a = ${avatarOf('Zoe')}; return a ? a.sub : null; })()`)) === 'TRIOS',
    String(await evaluate(`(function () { const a = ${avatarOf('Zoe')}; return a ? a.sub : null; })()`)));

  /* their own skin: a real .glb, parsed and rigged the way the player's own model
     is - which is the whole point of the room */
  const modelled = await until(undefined, `(function () {
    const a = ${avatarOf('Zoe')};
    if (!a || a.loading) return null;
    return { model: a.model, failed: a.failed, rigged: a.rigged };
  })()`, 30000);
  check('their character model is loaded and rigged, not a placeholder',
    !!modelled && modelled.model === true && modelled.rigged === true, JSON.stringify(modelled));

  /* ---------- the wire moves the room ----------
     Poses are placed at exact coordinates and the avatar is measured. It is
     interpolated, so it takes a moment to arrive - and the checks are that it
     arrives, and that it is walking while it does. */
  const seat = { x: walkedIn.x, z: walkedIn.z };
  zoe.send({ t: 'pose', id: 'Zoe', x: 0, y: 0, z: -3.4, yaw: 3.14, a: 'walk' });
  const arrived = await until(undefined, `(function () {
    const a = ${avatarOf('Zoe')};
    if (!a) return null;
    return (Math.abs(a.x - 0) + Math.abs(a.z + 3.4) < 0.6)
      ? { x: a.x, z: a.z, moving: a.moving, anim: a.anim } : null;
  })()`, 15000);
  check('a pose off the wire walks that player to the spot it names',
    !!arrived && arrived.moving === true && arrived.anim === 'walk', JSON.stringify(arrived));

  zoe.send({ t: 'pose', id: 'Zoe', x: 2.6, y: 0, z: 0.4, yaw: 1.6, a: 'walk' });
  const walkedTo = await until(undefined, `(function () {
    const a = ${avatarOf('Zoe')};
    if (!a) return null;
    return (Math.abs(a.x - 2.6) + Math.abs(a.z - 0.4) < 0.6)
      ? { x: a.x, z: a.z, yaw: a.yaw } : null;
  })()`, 15000);
  check('and a second pose takes them somewhere else', !!walkedTo, JSON.stringify(walkedTo));

  /* a pose that stops arriving - the sender closed their lobby - puts them back
     where their name belongs, instead of leaving them frozen mid-stride */
  const ttl = await evaluate(`Avatar.POSE_TTL`);
  await sleep(ttl + 1500);
  const seated = await until(undefined, `(function () {
    const a = ${avatarOf('Zoe')};
    if (!a) return null;
    return (Math.abs(a.x - ${seat.x}) + Math.abs(a.z - ${seat.z}) < 0.8 && !a.moving)
      ? { x: a.x, z: a.z, moving: a.moving } : null;
  })()`, 15000);
  check('a player whose poses stop walks back to their own seat',
    !!seated, JSON.stringify(seated) + ' seat was (' + seat.x + ',' + seat.z + ')');

  /* a skin change crosses the room as well */
  zoe.send({ t: 'presence', id: 'Zoe', party: ['Zoe'], mode: 'trios', skin: 'bonnie' });
  const reskinned = await until(undefined, `(function () {
    const a = ${avatarOf('Zoe')};
    return (a && a.skin === 'bonnie') ? { skin: a.skin, loading: a.loading, model: a.model } : null;
  })()`, 15000);
  check('a friend changing skin changes what is standing in the room',
    !!reskinned, JSON.stringify(reskinned));

  /* ---------- closing the room ---------- */
  const before = fake.stats.poses;
  await evaluate(`(function () { Lobby.close(); return true; })()`);
  await sleep(900);
  const after = fake.stats.poses;
  const shut = await evaluate(`(function () {
    return { open: Lobby.state().open, poseWant: !!Net.poseWant, avatars: Avatar.count() };
  })()`);
  check('closing the room stops publishing and clears the floor',
    shut.open === false && shut.poseWant === false && shut.avatars === 0 && after === before,
    JSON.stringify(shut) + ' | poses ' + before + ' -> ' + after);

  /* and a player who goes away is taken off it */
  await evaluate(`(function () { document.getElementById('btnLobby').click(); return true; })()`);
  await until(undefined, `Lobby.state().open && Avatar.onFloor('Zoe') ? true : null`, 15000);
  zoe.close();
  const gone = await until(undefined, `Avatar.onFloor('Zoe') ? null : 'gone'`, 15000);
  check('a player who leaves is taken off the floor', gone === 'gone', String(gone));

  /* ---------- put it down ---------- */
  try {
    await evaluate(`(function () { Lobby.close(); Net.disconnect(); return true; })()`);
  } catch (e) { /* gone */ }
  await fake.close();
  await new Promise(resolve => files.close(resolve));
  return { opened, walkedIn, modelled, arrived, seated, reskinned, poses: fake.stats.poses };
};
