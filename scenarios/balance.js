// Balance harness: runs a whole bot-only match (the player is made immortal and
// ignored by the damage system) and prints the alive curve plus a breakdown of
// what is killing everyone, so the lethality of the AI can be tuned.
module.exports = async function balance(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1000);

  await evaluate(`(function () {
    /* Make the human a harmless spectator for measurement purposes: immortal,
       and parked far off-shore so the bots do not treat him as a target. */
    Player.hp = 1e9;
    var od = Hit.damage.bind(Hit);
    Hit.damage = function (e, amount, opts) {
      if (e === Player) return 0;
      window.__bal.events++;
      var a = opts && opts.attacker;
      if (!a) window.__bal.storm++; else window.__bal.bullet++;
      return od(e, amount, opts);
    };
    window.__bal = { events: 0, storm: 0, bullet: 0, curve: [] };
    window.__bal.decoy = function () {
      Player.pos.set(-470, 6, -470);
      Player.hp = 1e9;
    };
    return 'ok';
  })()`);

  /* sim in 30 s slices, recording the alive curve */
  let curve = [];
  for (let i = 0; i < 22; i++) {
    const r = await evaluate(`(function () {
      for (var s = 0; s < 600; s++) {
        if (App.state === 'GAME_OVER') break;
        Game.update(0.05);
        window.__bal.decoy();                     // keep the human out of the fight
      }
      return { state: App.state, alive: App.aliveCount, bots: Bots.aliveCount(),
               zone: Zone.state, phase: Zone.phase, r: +Zone.cur.r.toFixed(1),
               t: +App.matchTime.toFixed(0), bal: window.__bal,
               botKills: BOTS.reduce(function (a, b) { return a + (b.kills || 0); }, 0) };
    })()`);
    curve.push(r);
    console.log('    t=' + String(r.t).padStart(3) + 's  alive=' + String(r.alive).padStart(3) +
      '  zone=' + r.zone.padEnd(6) + ' phase=' + r.phase + ' r=' + r.r +
      '  bulletDmg=' + r.bal.bullet + ' stormDmg=' + r.bal.storm + ' botKills=' + r.botKills);
    if (r.state === 'GAME_OVER') break;
  }
  const last = curve[curve.length - 1];
  check('balance sim ran', !!last, '-');
  console.log('\n  curve: ' + curve.map(c => c.t + 's:' + c.alive).join('  '));
  const at = s => { const c = curve.find(c => c.t >= s); return c ? c.alive : -1; };
  console.log('  alive@60=' + at(60) + '  alive@120=' + at(120) + '  alive@240=' + at(240) +
    '  alive@360=' + at(360));
  console.log('  final: ' + JSON.stringify({ state: last.state, alive: last.alive,
    phase: last.phase, r: last.r, botKills: last.botKills, storm: last.bal.storm }));
};
