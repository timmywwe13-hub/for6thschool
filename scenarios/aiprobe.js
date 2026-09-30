// AI probe: does the engagement pipeline actually fire? Instruments the live
// game (Hit.damage, Bots.checkSight, World.losClear) with counters, starts a
// match, fast-forwards and reports where the chain breaks.
module.exports = async function aiprobe(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(800);

  const inst = await evaluate(`(function () {
    window.__probe = {
      damage: 0, botDamage: 0, botToBot: 0, botToPlayer: 0, playerToBot: 0,
      lethal: 0, botAttackerKills: 0,
      sightCalls: 0, sightFound: 0, sightLosFail: 0, sightRange0: 0,
      losCalls: 0, losTrue: 0, engageEntries: 0, fireAt: 0, fireShots: 0,
      states: {}, maxBotsAlive: 0
    };
    const P = window.__probe;
    const origDamage = Hit.damage.bind(Hit);
    Hit.damage = function (e, amount, o) {
      P.damage++;
      const a = o && o.attacker;
      if (a && a !== Player) P.botDamage++;
      if (a && a !== Player && e && e !== Player) P.botToBot++;
      if (a && a !== Player && e === Player) P.botToPlayer++;
      if (a === Player && e && e !== Player) P.playerToBot++;
      if (e && e.hp - amount <= 0) P.lethal++;
      return origDamage(e, amount, o);
    };
    const origSight = Bots.checkSight.bind(Bots);
    Bots.checkSight = function (b, dt) {
      P.sightCalls++;
      const r = origSight(b, dt);
      if (r) P.sightFound++;
      return r;
    };
    const origNearest = Bots.nearestEnemy.bind(Bots);
    Bots.nearestEnemy = function (b, d) {
      const e = origNearest(b, d);
      if (e) P.sightRange0++;
      return e;
    };
    const origLos = World.losClear.bind(World);
    World.losClear = function (a, b2, c, d, e, f) {
      P.losCalls++;
      const r = origLos(a, b2, c, d, e, f);
      if (r) P.losTrue++;
      return r;
    };
    const origFire = Bots.fireAt.bind(Bots);
    Bots.fireAt = function (b, t, di, dt) {
      P.fireAt++;
      const m0 = b.mag;
      origFire(b, t, di, dt);
      if (b.mag < m0) P.fireShots++;
    };
    const origStep = Bots.step.bind(Bots);
    Bots.step = function (b, dt) {
      const s0 = b.state;
      origStep(b, dt);
      if (b.state !== s0 && b.state === 'engage') P.engageEntries++;
    };
    return 'instrumented';
  })()`);
  check('instrumentation installed', inst === 'instrumented', inst);

  const sim = async (seconds, dt) => {
    const r = await evaluate(`(function () {
      var steps = Math.round(${seconds} / ${dt});
      /* the match opens on the battle bus: ride to the island, then jump, so the
         step budget is spent in a live match rather than in the air */
      if (App.state === 'BUS') {
        for (var bb = 0; bb < 3000 && App.state === 'BUS' &&
             Math.hypot(Bus.pos.x, Bus.pos.z) > 290; bb++) Bus.update(1 / 60);
        Bus.jump();
      }
      for (var i = 0; i < steps; i++) {
        if (App.state === 'GAME_OVER') break;
        try { Game.update(${dt}); } catch (e) { return { err: e.message + ' | ' + String(e.stack||'').split('\\n')[1] }; }
      }
      var P = window.__probe;
      P.states = {};
      for (var i = 0; i < BOTS.length; i++) {
        if (!BOTS[i].alive) continue;
        P.states[BOTS[i].state] = (P.states[BOTS[i].state] || 0) + 1;
      }
      var bySkill = 0, magSum = 0, ySum = 0, eng = 0, n = 0;
      for (var i = 0; i < BOTS.length; i++) {
        var b = BOTS[i];
        if (!b.alive) continue;
        n++; magSum += b.mag; ySum += b.pos.y;
        if (b.state === 'engage') eng++;
      }
      return {
        err: null, probe: P, alive: App.aliveCount, botAlive: Bots.aliveCount(),
        avgMag: n ? +(magSum / n).toFixed(1) : 0, avgY: n ? +(ySum / n).toFixed(1) : 0,
        engaged: eng, sample: BOTS.filter(function (b) { return b.alive; }).slice(0, 4).map(function (b) {
          return { st: b.state, y: +b.pos.y.toFixed(1), x: +b.pos.x.toFixed(0), z: +b.pos.z.toFixed(0),
                   mag: b.mag, hp: Math.round(b.hp), seen: b.hasSeen, wp: b.weaponId };
        }),
        appState: App.state, playerY: +Player.pos.y.toFixed(1),
        playerAir: Player.airborne, playerGrounded: Player.grounded,
        playerHp: Math.round(Player.hp), playerAlive: Player.alive
      };
    })()`);
    return r;
  };

  let r = await sim(20, 0.05);
  console.log('  after 20s: ' + JSON.stringify({
    appState: r.appState, playerY: r.playerY, playerAir: r.playerAir,
    playerGrounded: r.playerGrounded, alive: r.alive, states: r.probe.states,
    probe: r.probe
  }));
  console.log('  sample bots: ' + JSON.stringify(r.sample));
  check('player landed', !r.playerAir && r.appState !== 'DROP' && r.appState !== 'BUS',
    r.appState + ' y=' + r.playerY);
  check('bots land and leave drop state', !(r.probe.states.drop > 0 && r.probe.states.loot === undefined),
    JSON.stringify(r.probe.states));
  check('bot vision ran', r.probe.sightCalls > 100, r.probe.sightCalls + ' sight checks');
  check('bots find enemies in range', r.probe.sightRange0 > 0, r.probe.sightRange0 + ' candidates found');
  check('LOS is clear sometimes', r.probe.losTrue > 0, r.probe.losTrue + '/' + r.probe.losCalls);

  r = await sim(60, 0.05);
  console.log('  after 80s: ' + JSON.stringify({
    alive: r.alive, states: r.probe.states, engaged: r.engaged,
    damage: r.probe.damage, botToBot: r.probe.botToBot, botToPlayer: r.probe.botToPlayer,
    shots: r.probe.fireShots, sightFound: r.probe.sightFound, engageEntries: r.probe.engageEntries,
    avgMag: r.avgMag, avgY: r.avgY, playerHp: r.playerHp
  }));
  check('bots entered engage state', r.probe.engageEntries > 0, r.probe.engageEntries + ' entries');
  check('bots fired shots at each other', r.probe.fireShots > 0, r.probe.fireShots + ' shots');
  check('bots dealt damage', r.probe.damage > 0, r.probe.damage + ' damage events');
  check('bot-vs-bot combat happened', r.probe.botToBot > 0, r.probe.botToBot + ' events');

  /* Walk the player into a live bot's face so the "bots shoot humans" path is
     exercised deterministically instead of depending on where the drop landed. */
  await evaluate(`(function () {
    /* the probes above usually end with the player dead, so start a fresh match */
    if (App.state === 'GAME_OVER') document.getElementById('btnPlayAgain').click();
    return App.state;
  })()`);
  await sleep(1500);
  const duel = await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < 600 && App.state === 'DROP'; i++) Game.update(0.05);
    var b = null;
    /* Guns only come out of chests now, so the bot walked into the player's face
       has to be one that actually found one - and one that is ALONE: a bot with
       another bot on top of it keeps fighting that one (checkSight holds the
       current target), so the human placed in front of it never gets shot. */
    for (var w = 0; w < 1200 && !b; w++) {
      for (var i = 0; i < BOTS.length; i++) {
        var cand = BOTS[i];
        if (!cand.alive || !cand.weaponId || cand.mag <= 0) continue;
        var alone = true;
        for (var j = 0; j < BOTS.length; j++) {
          if (j === i || !BOTS[j].alive) continue;
          if (Math.hypot(BOTS[j].pos.x - cand.pos.x, BOTS[j].pos.z - cand.pos.z) < 30) { alone = false; break; }
        }
        if (!alone) continue;
        b = cand;
        break;
      }
      if (!b) Game.update(0.05);
    }
    if (!b) return { err: 'no armed live bot' };
    Player.alive = true; Player.hp = 100; Player.shield = 0;
    Player.grounded = true; Player.airborne = false;
    /* Place the player where the bot can SEE them: 5-6 m out, at the bot's own
       height, on the first side with a clear line of sight. The fixed +5/+5
       offset used to be enough, but the island's buildings are denser now and a
       wall in the way turned this into a test of wall thickness rather than of
       "a bot shoots a human" - the path it is here to exercise. */
    var eye = 1.55, placed = false;
    var offs = [[5, 5], [6, 0], [0, 6], [-6, 0], [0, -6], [-5, -5], [5, -5], [-5, 5]];
    for (var o = 0; o < offs.length && !placed; o++) {
      var px = b.pos.x + offs[o][0], pz = b.pos.z + offs[o][1];
      var py = World.heightAt(px, pz);
      if (Math.abs(py - b.pos.y) > 2.5) continue;
      if (!World.losClear(px, py + eye, pz, b.pos.x, b.pos.y + eye, b.pos.z)) continue;
      Player.pos.set(px, py, pz);
      placed = true;
    }
    if (!placed) {
      var fx = b.pos.x + 5, fz = b.pos.z + 5;
      Player.pos.set(fx, World.heightAt(fx, fz), fz);
    }
    window.__probe.botToPlayer = 0;
    var steps = 0;
    for (var i = 0; i < 600; i++) {
      if (App.state === 'GAME_OVER') break;
      Game.update(0.05);
      steps++;
      if (window.__probe.botToPlayer > 0) break;
    }
    return { shots: window.__probe.botToPlayer, steps: steps,
             playerHp: Math.round(Player.hp), playerAlive: Player.alive,
             state: App.state };
  })()`);
  console.log('  duel: ' + JSON.stringify(duel));
  check('bots engage and damage the player when they meet', duel.shots > 0,
    duel.shots + ' hits on the player after ' + duel.steps + ' steps (hp ' + duel.playerHp + ')');
};