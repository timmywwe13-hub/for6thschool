// Focused probe: can the player end up UNDER the world on either map?
//
// The bare terrain query is a hard surface, so the interesting case is a
// walkable PLATFORM (pier deck, dam crest, crate top, hay bale, window sill).
// World.groundAt only counts a platform that sits at most 0.62 m above the
// feet - that is the step-up window - so a frame long enough to carry the body
// more than 0.62 m downwards in one go steps straight past the platform. The
// body then lands on the sea bed / terrain UNDER it, and World.resolve only
// pushes horizontally, so it stays there: exactly "I fell under the map".
//
// It drops the player onto the biggest platforms on both maps at a normal
// frame rate, at a 30 Hz rate and with deliberate 0.1 s spikes, and reports
// every sample where the feet end up more than 0.5 m under a platform they
// were dropped straight onto.
module.exports = async function fallprobe(ctx) {
  const { evaluate, check } = ctx;

  const res = await evaluate(`(function () {
    var out = {};
    var maps = ['isle', 'surf'];

    window.__keys = function (o) {
      /* Input.updateAxes() reads the BOUND actions - fwd/back/left/right/sprint/
         crouch - not raw key codes, so the walk-in test has to press 'fwd' and
         not 'KeyW' (which updateAxes ignores, leaving the test walking on the
         spot and proving nothing) */
      var k = Object.create(null), n;
      for (n in (o || {})) {
        if (!o[n]) continue;
        if (n === 'jump') { Input.jumpQueued = true; continue; }
        k[n === 'KeyW' ? 'fwd' : n === 'KeyS' ? 'back' : n === 'KeyA' ? 'left' : n === 'KeyD' ? 'right' : n] = true;
      }
      Input.keys = k; Input.updateAxes();
    };

    for (var m = 0; m < maps.length; m++) {
      var map = maps[m];
      World.build(QUALITY_PRESETS.high, 20240 + m, map);
      App.state = 'PLAYING';

      /* the big walkable platforms: anything with a real footprint */
      var plats = [];
      for (var i = 0; i < World.platforms.length; i++) {
        var p = World.platforms[i];
        if (p.hx * p.hz < 40) continue;
        if (p.y < World.heightAt(p.x, p.z)) continue;
        plats.push(p);
      }
      plats.sort(function (a, b) { return (b.hx * b.hz) - (a.hx * a.hz); });
      plats = plats.slice(0, 22);

      var runs = [0, 1, 2], rates = [1 / 60, 1 / 30, 0.1];
      var tunnels = [], checked = 0;
      for (var r = 0; r < plats.length; r++) {
        var pl = plats[r];
        for (var q = 0; q < runs.length; q++) {
          var dt = rates[q];
          window.__keys({});
          Player.pos.set(pl.x, pl.y + 30, pl.z);
          Player.vel.set(0, 0, 0);
          Player.airborne = true; Player.gliderOpen = false;
          Player.grounded = false; Player.alive = true; Player.hp = CONFIG.MAX_HP;
          Player.using = null;
          for (var f = 0; f < 400; f++) {
            /* pin the x/z so this is a pure vertical drop onto the platform:
               the skydive drifts toward the island centre when no key is
               held, which would land the body beside a narrow deck instead */
            Player.pos.x = pl.x; Player.pos.z = pl.z;
            Game.update(dt);
            Player.pos.x = pl.x; Player.pos.z = pl.z;
            if (Player.grounded) break;
          }
          checked++;
          /* the body is inside the platform's footprint - it has to be
             standing on top of it, not underneath it */
          if (Player.pos.y < pl.y - 0.5) {
            tunnels.push({ x: +pl.x.toFixed(0), z: +pl.z.toFixed(0), top: +pl.y.toFixed(2),
              got: +Player.pos.y.toFixed(2), dt: +dt.toFixed(4) });
          }
        }
      }

      /* The on-foot integrator: a body that is already falling fast, one step
         away from the platform it is about to hit - the state after a rocket
         knockback, a long jump off a hill, or simply a dropped frame on the way
         down. This one goes through Player.update, not the parachute. */
      var fallTunnels = [];
      for (var ff = 0; ff < plats.length; ff++) {
        var pf = plats[ff];
        for (var q2 = 0; q2 < runs.length; q2++) {
          var dt2 = rates[q2];
          window.__keys({});
          Player.pos.set(pf.x, pf.y + 6.5, pf.z);
          Player.vel.set(0, -26, 0);
          Player.airborne = false; Player.gliderOpen = false;
          Player.grounded = false; Player.alive = true; Player.hp = CONFIG.MAX_HP;
          Player.using = null; Player.mantle = null;
          for (var f3 = 0; f3 < 200; f3++) {
            Player.pos.x = pf.x; Player.pos.z = pf.z;
            Player.hp = CONFIG.MAX_HP;
            Player.update(dt2);
            Player.pos.x = pf.x; Player.pos.z = pf.z;
            if (Player.grounded) break;
          }
          if (Player.pos.y < pf.y - 0.5) {
            fallTunnels.push({ x: +pf.x.toFixed(0), z: +pf.z.toFixed(0), top: +pf.y.toFixed(2),
              got: +Player.pos.y.toFixed(2), dt: +dt2.toFixed(4) });
          }
        }
      }

      /* and the same for a walk-on, which is how a player meets a crate or a
         pier in a real match: walk at it, no drop at all */
      var walkTunnels = [], walkTunnelN = 0;
      for (var w = 0; w < plats.length; w++) {
        var pw = plats[w];
        /* A plank's collider is the AABB of a rotated box, so a deck over water
           has AABB area hanging over the lake: a walker who falls off the side
           lands in the water "inside" it and would read as a tunnel. The walk
           test is about stepping onto something standing on land. */
        if (World.heightAt(pw.x, pw.z) <= CONFIG.SEA_LEVEL + 0.1) continue;
        var startX = pw.x - Math.max(3, pw.hx + 2), startZ = pw.z;
        Player.pos.set(startX, pw.y, pw.z);
        Player.vel.set(0, 0, 0);
        Player.airborne = false; Player.gliderOpen = false;
        Player.grounded = true; Player.alive = true; Player.hp = CONFIG.MAX_HP;
        CAM.yaw = Math.PI / 2; CAM.pitch = 0; CAM.sync();
        window.__keys({ KeyW: true });
        for (var g = 0; g < 200; g++) Game.update((g % 9 === 0) ? 0.1 : 1 / 60);
        window.__keys({});
        if (Player.pos.x > pw.x - pw.hx && Player.pos.x < pw.x + pw.hx &&
            Player.pos.y < pw.y - 0.5) {
          walkTunnelN++;
          if (walkTunnels.length < 4) {
            walkTunnels.push({ at: [Math.round(pw.x), Math.round(pw.z)],
              top: +pw.y.toFixed(2), half: [+pw.hx.toFixed(1), +pw.hz.toFixed(1)],
              ground: +World.heightAt(pw.x, pw.z).toFixed(2),
              from: [Math.round(startX), Math.round(startZ)],
              to: [Math.round(Player.pos.x), Math.round(Player.pos.z)],
              got: +Player.pos.y.toFixed(2) });
          }
        }
      }

      /* A bot's parachute descent onto the same platforms. dropStep falls at
         CONFIG.DROP_FALL_SPEED until the canopy opens, which at a 0.1 s step is
         several metres per frame - far more than the step-up window the ground
         query uses. */
      var r0 = Bots.reset(1);
      var bot = BOTS[0];
      var botTunnels = [];
      for (var z = 0; z < plats.length; z++) {
        var bp = plats[z];
        for (var s2 = 0; s2 < rates.length; s2++) {
          bot.alive = true;
          bot.dropX = bp.x; bot.dropZ = bp.z;
          bot.pos.set(bp.x, bp.y + 120, bp.z);
          bot.chuteOpen = false;
          bot.state = 'drop';
          for (var f2 = 0; f2 < 3000; f2++) {
            Bots.dropStep(bot, rates[s2]);
            if (bot.state !== 'drop') break;
          }
          if (bot.pos.y < bp.y - 0.5) {
            botTunnels.push({ x: +bp.x.toFixed(0), z: +bp.z.toFixed(0), top: +bp.y.toFixed(2),
              got: +bot.pos.y.toFixed(2), dt: +rates[s2].toFixed(4) });
          }
        }
      }
      Bots.clear();

      out[map] = {
        platformsTested: plats.length, dropsTested: checked,
        tunnels: tunnels.slice(0, 6), tunnelCount: tunnels.length,
        walkTunnels: walkTunnelN, walkTunnelAt: walkTunnels,
        fallTunnelCount: fallTunnels.length, fallTunnels: fallTunnels.slice(0, 6),
        botTunnelCount: botTunnels.length, botTunnels: botTunnels.slice(0, 6)
      };
    }
    window.__keys({});
    World.build(QUALITY_PRESETS[SETTINGS.quality] || QUALITY_PRESETS.high, 7, 'isle');
    return out;
  })()`);

  console.log('  fall probe: ' + JSON.stringify(res));
  for (const map of Object.keys(res)) {
    const r = res[map];
    check(`${map}: a drop never ends under the platform it lands on`,
      r.tunnelCount === 0, r.tunnelCount + '/' + r.dropsTested + ' ' + JSON.stringify(r.tunnels));
    check(`${map}: walking into a platform never puts you under it`,
      r.walkTunnels === 0, r.walkTunnels + ' platform(s)' +
      (r.walkTunnelAt && r.walkTunnelAt.length ? ' ' + JSON.stringify(r.walkTunnelAt) : ''));
    check(`${map}: a bot's parachute never lands it under the platform below`,
      r.botTunnelCount === 0, r.botTunnelCount + ' ' + JSON.stringify(r.botTunnels));
    check(`${map}: a fast fall onto a platform lands ON it, not through it`,
      r.fallTunnelCount === 0, r.fallTunnelCount + ' ' + JSON.stringify(r.fallTunnels));
  }
  return res;
};
