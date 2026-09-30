// Wall-shot scenario: bots must never damage anything through cover, and no
// tracer may pass through geometry.
module.exports = async function wallshot(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1400);

  const setup = await evaluate(`(function () {
    /* one live bot with an AR; the player is the target */
    window.__ws = { tracers: [], origBotsUpdate: Bots.update };
    Bots.update = function () {
      entityGrid.clear();
      if (Player.alive) entityGrid.insert(Player.pos.x, Player.pos.z, Player);
      for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) entityGrid.insert(BOTS[i].pos.x, BOTS[i].pos.z, BOTS[i]);
      BotView.flush();
    };
    /* record every tracer so we can check none of them pass through a wall */
    var origTracer = FX.tracer.bind(FX);
    FX.tracer = function (x1, y1, z1, x2, y2, z2) {
      window.__ws.tracers.push([x1, y1, z1, x2, y2, z2]);
      return origTracer(x1, y1, z1, x2, y2, z2);
    };
    for (var i = 1; i < BOTS.length; i++) { BOTS[i].alive = false; BotView.hide(BOTS[i].index); }
    var b = BOTS[0];
    b.alive = true; b.skill = 0.8; b.crouch = false;
    b.weapons = [{ id: 'ar', mag: 30 }]; b.weaponId = 'ar'; b.mag = 30;
    b.ammoReserve.medium = 500; b.reloadT = 0; b.fireT = 0; b.burstLeft = 0;
    b.helmetTier = 0; b.vestTier = 0;
    Player.alive = true; Player.hp = 1e9; Player.shield = 0;
    window.__ws.bot = b;
    return { bot: b.name };
  })()`);
  check('scenario setup ran', !!setup.bot, setup.bot);

  /* ---------------- the bot shoots through a house ---------------- */
  const through = await evaluate(`(function () {
    var b = window.__ws.bot;
    /* Find a building whose girth really does block the line between its two
       opposite faces: the first building in the world is rotated at random, so
       the axis it is measured along may miss the walls entirely. */
    var bd = null, y = 0, bx = 0, px = 0, pz = 0;
    for (var t = 0; t < World.towns.length && !bd; t++) {
      var list = World.towns[t].buildings;
      for (var i = 0; i < list.length; i++) {
        var cand = list[i];
        var cy = cand.y;
        var cbx = cand.x - cand.w / 2 - 2.2, cpx = cand.x + cand.w / 2 + 2.2, cpz = cand.z;
        var bY = World.groundAt(cbx, cpz, cy + 2), pY = World.groundAt(cpx, cpz, cy + 2);
        if (!World.losClear(cbx, bY + 1.3, cpz, cpx, pY + 1.0, cpz)) {
          bd = cand; y = cy; bx = cbx; px = cpx; pz = cpz;
          break;
        }
      }
    }
    if (!bd) return { err: 'no building blocked the line on either map' };
    /* bot on the west side of the house, player on the east side */
    b.pos.set(bx, World.groundAt(bx, pz, y + 2), pz);
    Player.pos.set(px, World.groundAt(px, pz, y + 2), pz);
    entityGrid.clear();
    entityGrid.insert(b.pos.x, b.pos.z, b);
    entityGrid.insert(Player.pos.x, Player.pos.z, Player);
    b.yaw = Math.atan2(Player.pos.x - b.pos.x, -(Player.pos.z - b.pos.z));
    var dist = Math.hypot(Player.pos.x - b.pos.x, Player.pos.z - b.pos.z);
    var losBlocked = !World.losClear(b.pos.x, b.pos.y + 1.3, b.pos.z,
                                     Player.pos.x, Player.pos.y + 1.0, Player.pos.z);
    var mag0 = b.mag, hp0 = Player.hp, tracer0 = window.__ws.tracers.length;
    var damageEvents = 0;
    var origDamage = Hit.damage.bind(Hit);
    Hit.damage = function (e, amount, opts) {
      if (opts && opts.attacker === b) damageEvents++;
      return origDamage(e, amount, opts);
    };
    /* hammer the trigger as if it had a cached sight line */
    for (var i = 0; i < 3000; i++) {
      b.mag = 30; b.fireT = 0; b.burstLeft = 0; b.reloadT = 0;
      Bots.fireAt(b, Player, dist, 0.05);
    }
    Hit.damage = origDamage;
    return { losBlocked: losBlocked, dist: +dist.toFixed(1), damageEvents: damageEvents,
             ammoSpent: mag0 - b.mag, tracers: window.__ws.tracers.length - tracer0,
             playerHp: Math.round(Player.hp), hpLost: Math.round(hp0 - Player.hp) };
  })()`);
  console.log('  through a house: ' + JSON.stringify(through));
  check('the wall really does block the line of fire', through.losBlocked === true,
    'distance ' + through.dist + ' m across the building');
  check('a bot deals NO damage through a wall', through.damageEvents === 0,
    through.damageEvents + ' damage events, player lost ' + through.hpLost + ' hp');
  check('it does not even fire: no ammo burned', through.ammoSpent === 0,
    through.ammoSpent + ' rounds spent');
  check('no tracer is drawn through the building', through.tracers === 0,
    through.tracers + ' tracers');

  /* ---------------- control: clear line of fire ---------------- */
  const open = await evaluate(`(function () {
    var b = window.__ws.bot;
    /* find a lane with a genuinely clear line between two points ~22 m apart */
    var lane = null;
    for (var i = 0; i < World.lootPoints.length && !lane; i++) {
      var s = World.lootPoints[i];
      var bx = s.x, bz = s.z - 11, px = s.x, pz = s.z + 11;
      var by = World.heightAt(bx, bz), py = World.heightAt(px, pz);
      if (by < 2.5 || py < 2.5) continue;
      if (World.losClear(bx, by + 1.3, bz, px, py + 1.0, pz)) lane = { bx: bx, bz: bz, by: by, px: px, pz: pz, py: py };
    }
    if (!lane) return { err: 'no clear lane found' };
    b.pos.set(lane.bx, lane.by, lane.bz);
    Player.pos.set(lane.px, lane.py, lane.pz);
    entityGrid.clear();
    entityGrid.insert(b.pos.x, b.pos.z, b);
    entityGrid.insert(Player.pos.x, Player.pos.z, Player);
    b.yaw = Math.atan2(Player.pos.x - b.pos.x, -(Player.pos.z - b.pos.z));
    var los = World.losClear(b.pos.x, b.pos.y + 1.3, b.pos.z,
                             Player.pos.x, Player.pos.y + 1.0, Player.pos.z);
    var hp0 = Player.hp, mag0 = b.mag, damageEvents = 0;
    var origDamage = Hit.damage.bind(Hit);
    Hit.damage = function (e, amount, opts) {
      if (opts && opts.attacker === b) damageEvents++;
      return origDamage(e, amount, opts);
    };
    for (var i = 0; i < 3000; i++) {
      b.mag = 30; b.fireT = 0; b.burstLeft = 0; b.reloadT = 0;
      Bots.fireAt(b, Player, 22, 0.05);
    }
    Hit.damage = origDamage;
    return { los: los, damageEvents: damageEvents, hpLost: Math.round(hp0 - Player.hp),
             ammoSpent: mag0 - b.mag };
  })()`);
  console.log('  in the open: ' + JSON.stringify(open));
  check('with a clear line the bot does shoot and damage', open.los === true &&
    open.damageEvents > 50, open.err || (open.damageEvents + ' hits, ' + open.hpLost + ' hp lost'));

  /* ---------------- audits on a live match ---------------- */
  /* start a fresh match so the world is full of armed bots and the tracer and
     invariant audited below measure real combat, not a stripped test world -
     and put the real AI back, since the setup above replaced Bots.update */
  await evaluate(`(function () {
    Bots.update = window.__ws.origBotsUpdate;
    document.getElementById('btnPlayAgain').click();
    return App.state;
  })()`);
  await sleep(1600);

  const tracers = await evaluate(`(function () {
    window.__ws.tracers.length = 0;
    /* the human is kept alive so the match cannot end mid-audit */
    for (var i = 0; i < 500; i++) { if (App.state !== 'DROP') break; Game.update(0.05); }
    for (var i = 0; i < 2400; i++) {
      if (App.state === 'GAME_OVER') break;
      Game.update(0.05);
      Player.hp = 1e9; Player.alive = true;
    }
    var bad = 0, checked = 0, worst = 0, samples = [];
    for (var i = 0; i < window.__ws.tracers.length; i++) {
      var t = window.__ws.tracers[i];
      var dx = t[3] - t[0], dy = t[4] - t[1], dz = t[5] - t[2];
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 0.2) continue;
      checked++;
      /* anything solid between the muzzle and just short of the tracer end means
         the tracer punched through cover */
      var h = World.raycast(t[0], t[1], t[2], dx / len, dy / len, dz / len, len - 0.12);
      if (h.t >= 0) {
        bad++;
        var depth = len - h.t;
        if (depth > worst) worst = depth;
        if (samples.length < 4) {
          samples.push({ len: +len.toFixed(2), hitAt: +h.t.toFixed(2), depth: +depth.toFixed(3),
                         kind: (h.obj === 'ground' ? 'ground' : 'structure'),
                         from: [+t[0].toFixed(1), +t[1].toFixed(1), +t[2].toFixed(1)],
                         to: [+t[3].toFixed(2), +t[4].toFixed(2), +t[5].toFixed(2)] });
        }
      }
    }
    return { tracers: window.__ws.tracers.length, checked: checked, throughWalls: bad,
             worstDepth: +worst.toFixed(3), samples: samples,
             matchTime: +App.matchTime.toFixed(0), alive: App.aliveCount };
  })()`);
  console.log('  tracer audit: ' + JSON.stringify(tracers));
  check('the match produced tracers to audit', tracers.checked > 20,
    tracers.checked + ' of ' + tracers.tracers + ' checked over ' + tracers.matchTime + ' s');
  check('no tracer passes through a wall or the ground', tracers.throughWalls === 0,
    tracers.throughWalls + ' penetrating tracers');

  const invariant = await evaluate(`(function () {
    /* every bullet hit in a real match is re-checked against the world */
    var violations = [], bullets = 0, splash = 0, leanOut = 0;
    var orig = Hit.damage.bind(Hit);
    Hit.damage = function (e, amount, opts) {
      var a = opts && opts.attacker;
      if (a && a !== e && e.pos) {
        if (opts.splash) splash++;
        else {
          bullets++;
          /* the game fires from the character's muzzle, not its centre, so the
             audit has to ask the same question the shot did: is the aim line from
             the muzzle clear? A body-to-body ray flags a legitimate shot around a
             corner the shooter is leaning out of. The muzzle is the game's own
             formula (Bots.fireAt), not the player's. */
          var ax = a.pos.x, ay = a.pos.y + (a.crouch ? 1.05 : 1.3), az = a.pos.z;
          var mx = ax, my = ay, mz = az, bodyClear = false, muzzleClear = false;
          if (a.yaw !== undefined) {
            mx = a.pos.x + Math.sin(a.yaw) * 0.65;
            mz = a.pos.z - Math.cos(a.yaw) * 0.65;
            my = a.pos.y + (a.crouch ? 1.05 : 1.3);
          }
          muzzleClear = World.losClear(mx, my, mz, e.pos.x,
            e.pos.y + (e.crouch ? 0.85 : 1.0), e.pos.z);
          bodyClear = World.losClear(ax, ay, az, e.pos.x, e.pos.y + 1.0, e.pos.z);
          if (!muzzleClear) {
            violations.push((a.name || 'player') + ' -> ' + (e.name || 'player') +
              ' muzzle=blocked body=' + (bodyClear ? 'clear' : 'blocked') +
              ' d=' + Math.hypot(e.pos.x - a.pos.x, e.pos.z - a.pos.z).toFixed(1));
          } else if (!bodyClear) {
            /* a legitimate lean-out shot: the game's own muzzle line is clear */
            leanOut = (leanOut || 0) + 1;
          }
        }
      }
      return orig(e, amount, opts);
    };
    for (var i = 0; i < 1600; i++) {
      if (App.state === 'GAME_OVER') break;
      Game.update(0.05);
      Player.hp = 1e9; Player.alive = true;
    }
    Hit.damage = orig;
    return { bullets: bullets, splash: splash, violations: violations.length, leanOut: leanOut || 0,
             sample: violations.slice(0, 4), matchTime: +App.matchTime.toFixed(0) };
  })()`);
  console.log('  match invariant: ' + JSON.stringify(invariant));
  check('a real match produced bullet damage to audit', invariant.bullets > 30,
    invariant.bullets + ' bullet hits (' + invariant.splash + ' splash ignored) at ' +
    invariant.matchTime + ' s');
  check('every bullet hit in a live match had a clear line of fire',
    invariant.violations === 0, invariant.violations + ' through-wall hits ' +
    (invariant.sample.join(', ') || 'none'));
};
