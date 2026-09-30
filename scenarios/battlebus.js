// The battle bus: the match opens on it, everybody rides, SPACE throws you out,
// the bots leave on their own timers and the bus dumps anybody still aboard when
// it runs out of line.
module.exports = async function battlebus(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`App.startMatch(); 1`);
  await sleep(150);

  const ride = await evaluate(`(function () {
    var out = { state: App.state, active: Bus.active, riding: Bus.riding };
    out.alt = +Bus.pos.y.toFixed(2);
    out.wantAlt = CONFIG.BUS_ALTITUDE;
    out.riderY = +Player.pos.y.toFixed(2);
    out.riders = Bus.riders();
    out.botsAboard = Bots.busRiderCount();
    out.bots = BOTS.length;
    /* the route is a real line across the island, not a point */
    out.routeLen = Math.round(Bus.len);
    out.routeEndsOffMap = Math.hypot(Bus.x0, Bus.z0) > CONFIG.ISLAND_RADIUS &&
                          Math.hypot(Bus.x1, Bus.z1) > CONFIG.ISLAND_RADIUS;
    out.routeCrossesIsland = Bus.len > CONFIG.ISLAND_RADIUS * 2;
    out.modelInScene = !!(Bus.group && Bus.group.parent);
    out.modelVisible = !!(Bus.group && Bus.group.visible);
    out.busPanel = !document.getElementById('busPanel').classList.contains('hidden');
    out.dropPanelHidden = document.getElementById('dropPanel').classList.contains('hidden');
    out.zoneTimer = Zone.timeLeft();
    out.zonePhase = Zone.phase;
    out.botsAlive = Bots.aliveCount();
    return out;
  })()`);
  console.log('  ride: ' + JSON.stringify(ride));
  check('the match opens on the battle bus', ride.state === 'BUS' && ride.active && ride.riding,
    ride.state);
  check('the bus cruises at its altitude', Math.abs(ride.alt - ride.wantAlt) < 1,
    ride.alt + ' vs ' + ride.wantAlt);
  check('the player sits on the bus', Math.abs(ride.riderY - ride.wantAlt) < 4,
    'y ' + ride.riderY);
  check('all 100 combatants ride together',
    ride.riders === 100 && ride.botsAboard === ride.bots,
    ride.riders + ' riders, ' + ride.botsAboard + '/' + ride.bots + ' bots');
  check('the route crosses the island from outside the map',
    ride.routeCrossesIsland && ride.routeEndsOffMap, ride.routeLen + ' m');
  check('the bus model is in the world and drawn', ride.modelInScene && ride.modelVisible);
  check('the bus panel replaces the drop panel', ride.busPanel && ride.dropPanelHidden);
  check('the storm waits for the drop', ride.zoneTimer > 40 && ride.zonePhase === 0,
    'timer ' + Math.round(ride.zoneTimer));
  check('nobody dies in the air', ride.botsAlive === ride.bots, ride.botsAlive + ' alive');

  const fly = await evaluate(`(function () {
    var out = {};
    var t0 = Bus.t, x0 = Bus.pos.x, z0 = Bus.pos.z;
    for (var f = 0; f < 600; f++) Bus.update(1 / 60);      // ten seconds
    out.advanced = Bus.t > t0;
    out.moved = Math.hypot(Bus.pos.x - x0, Bus.pos.z - z0);
    out.holdsAlt = Math.abs(Bus.pos.y - CONFIG.BUS_ALTITUDE) < 0.01;
    out.playerWithBus = Math.hypot(Player.pos.x - Bus.pos.x, Player.pos.z - Bus.pos.z) < 12;
    out.stillAboard = Bots.busRiderCount();
    out.jumpedSoFar = BOTS.length - out.stillAboard;
    return out;
  })()`);
  console.log('  fly: ' + JSON.stringify(fly));
  check('the bus travels along its route', fly.advanced && fly.moved > 200,
    Math.round(fly.moved) + ' m in 10 s');
  check('it holds cruise altitude', fly.holdsAlt);
  check('the player is carried with the bus', fly.playerWithBus);
  check('bots leave the bus over the ride, not all at once',
    fly.jumpedSoFar > 0 && fly.stillAboard > 0,
    fly.jumpedSoFar + ' jumped, ' + fly.stillAboard + ' still aboard');

  const exit = await evaluate(`(function () {
    var out = {};
    out.before = Bots.busRiderCount();
    out.jumped = Bus.jump();
    out.state = App.state;
    out.airborne = Player.airborne;
    out.glider = Player.gliderOpen;
    out.riding = Bus.riding;
    out.active = Bus.active;
    out.y = +Player.pos.y.toFixed(1);
    out.gotShove = Math.hypot(Player.vel.x, Player.vel.z) > 1;
    out.second = Bus.jump();                 // pressing again must do nothing
    Bus.finish();                            // the ride runs out
    out.afterFinish = Bots.busRiderCount();
    var stuck = 0;
    for (var i = 0; i < BOTS.length; i++) if (!BOTS[i].busJumped && BOTS[i].alive) stuck++;
    out.stuck = stuck;
    return out;
  })()`);
  console.log('  exit: ' + JSON.stringify(exit));
  check('jumping leaves the bus', exit.jumped && !exit.riding && !exit.active);
  check('the jump starts the skydive', exit.state === 'DROP' && exit.airborne && !exit.glider,
    exit.state);
  check('the exit carries momentum away from the bus', exit.gotShove, 'y ' + exit.y);
  check('you cannot jump twice', exit.second === false);
  check('the bus empties itself when the ride ends',
    exit.afterFinish === 0 && exit.stuck === 0,
    exit.afterFinish + ' left, ' + exit.stuck + ' stuck');

  const auto = await evaluate(`(function () {
    App.startMatch();
    var guard = 0;
    while (App.state === 'BUS' && guard++ < 4000) Bus.update(1 / 60);
    var out = { guard: guard, state: App.state, riding: Bus.riding,
                riders: Bots.busRiderCount() };
    guard = 0;
    while (Player.airborne && guard++ < 20000) Player.update(1 / 60);
    out.landed = !Player.airborne;
    out.landY = +Player.pos.y.toFixed(2);
    out.terrain = +World.heightAt(Player.pos.x, Player.pos.z).toFixed(2);
    out.onSurface = Player.pos.y >= World.heightAt(Player.pos.x, Player.pos.z) - 0.2;
    return out;
  })()`);
  console.log('  auto: ' + JSON.stringify(auto));
  check('an untouched ride ends on its own', auto.state === 'DROP' && !auto.riding,
    auto.state + ' after ' + auto.guard + ' frames');
  check('everybody is off the bus when it runs out', auto.riders === 0, auto.riders + ' aboard');
  check('the skydive still reaches the ground', auto.landed && auto.onSurface,
    'y ' + auto.landY + ' over terrain ' + auto.terrain);
  return { ride, fly, exit, auto };
};
