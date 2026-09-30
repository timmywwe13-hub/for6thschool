// Third-person scenario: mouse direction, the visible character, the orbit
// camera, its collision/ground clearance, camera-relative movement, and that
// shooting still lands where the crosshair points.
const moveOn = (dx, dy) => `(function () {
  Input.locked = true;                      // pointer lock is unavailable headless
  document.dispatchEvent(new MouseEvent('mousemove', {
    movementX: ${dx}, movementY: ${dy}, bubbles: true
  }));
  CAM.sync();                               // dir is only refreshed on a frame
  return { yaw: CAM.yaw, pitch: CAM.pitch, dir: [CAM.dir.x, CAM.dir.y, CAM.dir.z] };
})()`;

module.exports = async function thirdperson(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1200);

  /* Keep the human alive for the whole scenario: these are camera and movement
     tests, and a bot shooting the idle player mid-run would end the match and
     freeze the player state under the assertions. */
  await evaluate(`(function () {
    if (!window.__origHitDamage) {
      window.__origHitDamage = Hit.damage.bind(Hit);
      Hit.damage = function (e, amount, opts) {
        if (e === Player) return 0;
        return window.__origHitDamage(e, amount, opts);
      };
    }
    return 'ok';
  })()`);
  await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < 600 && App.state === 'DROP'; i++) Game.update(0.05);
    Player.hp = 100; Player.alive = true;
    return App.state;
  })()`);

  /* ---------------- mouse direction ---------------- */
  const base = await evaluate(`(function () {
    CAM.yaw = 0; CAM.pitch = 0; CAM.sync();
    return { yaw: CAM.yaw, dirX: CAM.dir.x, dirZ: CAM.dir.z };
  })()`);
  const right = await evaluate(moveOn(120, 0));
  const left = await evaluate(moveOn(-240, 0));
  const down = await evaluate(moveOn(0, 120));
  const up = await evaluate(moveOn(0, -240));

  console.log('  facing north: dir=' + JSON.stringify([base.dirX.toFixed(2), base.dirZ.toFixed(2)]) +
    '  mouse right -> yaw ' + right.yaw.toFixed(3) + ' dir.x ' + right.dir[0].toFixed(2));
  check('starting state faces north (-Z)', Math.abs(base.dirZ + 1) < 0.01 && base.dirX === 0,
    'dir=(' + base.dirX + ',' + base.dirZ + ')');
  check('mouse RIGHT turns the view right (+X, yaw increases)',
    right.yaw > 0 && right.dir[0] > 0, 'yaw ' + right.yaw.toFixed(3) + ' dir.x ' + right.dir[0].toFixed(2));
  check('mouse LEFT turns the view left (yaw decreases)',
    left.yaw < right.yaw, 'yaw ' + left.yaw.toFixed(3));
  check('vertical look is NOT inverted (mouse down = look down)',
    down.pitch < 0 && down.dir[1] < 0, 'pitch ' + down.pitch.toFixed(3));
  check('mouse up looks up', up.pitch > down.pitch, 'pitch ' + up.pitch.toFixed(3));

  /* ---------------- the character exists and matches the player ---------------- */
  await evaluate(`(function () { CAM.pitch = -0.15; Game.update(0.05); Game.render(0.05); return 'ok'; })()`);
  const model = await evaluate(`(function () {
    var g = null;
    App.scene.traverse(function (o) { if (o.isGroup && o.children.length >= 7 && !g) g = o; });
    if (!g) return { err: 'no character group in the scene' };
    var box = new THREE.Box3();
    box.makeEmpty();
    g.traverse(function (o) {
      if (!o.isMesh || !o.visible || o.geometry.type === 'ConeGeometry') return;
      box.expandByObject(o);
    });
    return {
      visible: g.visible, children: g.children.length,
      hasCapsule: g.children.some(function (c) { return c.geometry && c.geometry.type === 'CapsuleGeometry'; }),
      hasSphere: g.children.some(function (c) { return c.geometry && c.geometry.type === 'SphereGeometry'; }),
      height: +(box.max.y - box.min.y).toFixed(2),
      dx: +(g.position.x - Player.pos.x).toFixed(3),
      dz: +(g.position.z - Player.pos.z).toFixed(3),
      dy: +(g.position.y - Player.pos.y).toFixed(3),
      rotY: +g.rotation.y.toFixed(3), playerYaw: +Player.yaw.toFixed(3),
      camDist: +Math.hypot(CAM.pos.x - Player.pos.x, CAM.pos.z - Player.pos.z).toFixed(2),
      camAboveFeet: +(CAM.pos.y - Player.pos.y).toFixed(2)
    };
  })()`);
  console.log('  model: ' + JSON.stringify(model));
  check('the player has a visible character in the world', model.visible === true && !model.err,
    model.err || model.children + ' parts, ' + model.height + ' m tall');
  check('the character is a humanoid built from primitives',
    model.hasCapsule === true && model.hasSphere === true, 'capsule + sphere');
  check('the character stands exactly on the player position',
    Math.abs(model.dx) < 0.01 && Math.abs(model.dz) < 0.01 && Math.abs(model.dy) < 0.01,
    'offset (' + model.dx + ',' + model.dy + ',' + model.dz + ')');
  check('the character faces the camera aim direction',
    Math.abs(model.rotY - (Math.PI - model.playerYaw)) < 0.01,
    'rotY ' + model.rotY + ' vs PI-yaw ' + (Math.PI - model.playerYaw).toFixed(3));

  /* ---------------- camera orbit: behind, above, orbiting ---------------- */
  const orbit = await evaluate(`(function () {
    /* Stand the player on open ground first. Where the bus drop leaves them is
       luck, and a hill, a tree trunk or a wall right behind them correctly pulls
       the boom in - which is what this measured whenever the drop happened to
       land badly, and says nothing about the plain third-person distance. */
    var spot = World.lootPoints[0], sy = World.heightAt(spot.x, spot.z);
    Player.pos.set(spot.x, sy, spot.z);
    Player.vel.set(0, 0, 0); Player.grounded = true; Player.airborne = false;
    CAM.pitch = -0.15;
    Player.camReach = CONFIG.CAM_DIST;
    for (var k = 0; k < 12; k++) Player.updateCamera(0.05);
    var out = {}, before = { x: CAM.pos.x, z: CAM.pos.z };
    Game.update(0.05); Game.render(0.05);
    out.dist = +Math.hypot(CAM.pos.x - Player.pos.x, CAM.pos.z - Player.pos.z).toFixed(2);
    out.above = +(CAM.pos.y - Player.pos.y).toFixed(2);
    var bx = CAM.pos.x - Player.pos.x, bz = CAM.pos.z - Player.pos.z;
    var len = Math.hypot(bx, bz) || 1;
    out.behind = +((bx / len) * CAM.dir.x + (bz / len) * CAM.dir.z).toFixed(2);
    Input.locked = true;
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 500, movementY: 0, bubbles: true }));
    for (var i = 0; i < 20; i++) Game.update(0.05);
    Game.render(0.05);
    out.moved = +Math.hypot(CAM.pos.x - before.x, CAM.pos.z - before.z).toFixed(2);
    var cx = CAM.pos.x - Player.pos.x, cz = CAM.pos.z - Player.pos.z;
    var l = Math.hypot(cx, cz) || 1;
    out.stillBehind = +((cx / l) * CAM.dir.x + (cz / l) * CAM.dir.z).toFixed(2);
    return out;
  })()`);
  console.log('  camera: ' + JSON.stringify(orbit));
  check('camera sits behind the player', orbit.behind < -0.6, 'dot ' + orbit.behind);
  check('camera sits above the player', orbit.above > 1.0, orbit.above + ' m up');
  check('camera holds a third-person distance', orbit.dist > 2.2 && orbit.dist < 5.5,
    orbit.dist + ' m');
  check('camera orbits around the player when the mouse moves', orbit.moved > 1.5,
    'moved ' + orbit.moved + ' m');
  check('camera stays behind after orbiting', orbit.stillBehind < -0.6, 'dot ' + orbit.stillBehind);

  /* ---------------- camera collision + ground clearance ---------------- */
  const collide = await evaluate(`(function () {
    /* find a tall wall face: thin in one axis, long in the other (any building
       wall qualifies) */
    var wall = null;
    for (var i = 0; i < World.colliders.length; i++) {
      var c = World.colliders[i];
      if (c.cyl || !c.hx) continue;
      if ((c.y1 - c.y0) > 2 && Math.max(c.hx, c.hz) > 3 && Math.min(c.hx, c.hz) < 0.6) { wall = c; break; }
    }
    var out = { foundCollider: !!wall };
    if (!wall) return out;
    var thinX = wall.hx < wall.hz;          // the wall runs N-S if thin in X
    /* stand just outside its thin face, facing away from it, so the camera
       wants to sit inside the wall */
    var px = thinX ? wall.x + wall.hx + 1.7 : wall.x;
    var pz = thinX ? wall.z : wall.z - wall.hz - 1.7;
    var gy = World.groundAt(px, pz, wall.y1 + 1);
    Player.pos.set(px, gy, pz);
    Player.vel.set(0, 0, 0);
    Player.grounded = true; Player.airborne = false;
    CAM.yaw = thinX ? Math.atan2(1, 0) : 0;   // face +X / -Z, away from the wall
    CAM.pitch = 0;
    Player.yaw = CAM.yaw;
    Player.camReach = CONFIG.CAM_DIST;
    for (var i = 0; i < 12; i++) Player.updateCamera(0.05);
    out.blockedDist = +Math.hypot(CAM.pos.x - Player.pos.x, CAM.pos.z - Player.pos.z).toFixed(2);
    /* open ground for comparison */
    var spot = World.lootPoints[0], sy = World.heightAt(spot.x, spot.z);
    Player.pos.set(spot.x, sy, spot.z);
    Player.camReach = CONFIG.CAM_DIST;
    for (var i = 0; i < 12; i++) Player.updateCamera(0.05);
    out.openDist = +Math.hypot(CAM.pos.x - Player.pos.x, CAM.pos.z - Player.pos.z).toFixed(2);
    /* ground clearance: aim straight down from the lowest pitch */
    CAM.pitch = CONFIG.CAM_PITCH_MIN;
    Player.camReach = CONFIG.CAM_DIST;
    for (var i = 0; i < 12; i++) Player.updateCamera(0.05);
    out.camAboveGround = +(CAM.pos.y - World.groundAt(CAM.pos.x, CAM.pos.z, CAM.pos.y)).toFixed(2);
    out.minDist = CONFIG.CAM_MIN_DIST;
    CAM.pitch = -0.15;
    return out;
  })()`);
  console.log('  collision: ' + JSON.stringify(collide));
  check('camera is pulled in when a wall is behind the player',
    collide.blockedDist < collide.openDist - 0.3,
    collide.blockedDist + ' m at a wall vs ' + collide.openDist + ' m in the open');
  check('camera never comes closer than the minimum distance',
    collide.blockedDist >= collide.minDist - 0.01, collide.blockedDist + ' m');
  check('camera stays above the ground when looking down',
    collide.camAboveGround > 0.1, collide.camAboveGround + ' m above terrain');

  /* ---------------- movement is camera relative ---------------- */
  const move = await evaluate(`(function () {
    var spot = World.lootPoints[3], sy = World.heightAt(spot.x, spot.z);
    Player.pos.set(spot.x, sy, spot.z);
    Player.vel.set(0, 0, 0);
    Player.yaw = CAM.yaw; CAM.pitch = 0; CAM.sync();
    var out = {};
    Input.keys = Object.create(null);
    Input.moveX = 0; Input.moveZ = 1;                       // W
    var p0x = Player.pos.x, p0z = Player.pos.z;
    for (var i = 0; i < 12; i++) Player.update(0.05);
    var mx = Player.pos.x - p0x, mz = Player.pos.z - p0z;
    var ml = Math.hypot(mx, mz) || 1;
    out.forwardDot = +((mx / ml) * CAM.dir.x + (mz / ml) * CAM.dir.z).toFixed(2);
    out.moved = +ml.toFixed(2);
    Input.moveZ = 0; Input.moveX = 1;                       // D
    p0x = Player.pos.x; p0z = Player.pos.z;
    for (var i = 0; i < 12; i++) Player.update(0.05);
    mx = Player.pos.x - p0x; mz = Player.pos.z - p0z;
    ml = Math.hypot(mx, mz) || 1;
    out.rightDot = +((mx / ml) * CAM.right.x + (mz / ml) * CAM.right.z).toFixed(2);
    Input.moveX = 0; Input.keys = Object.create(null);
    return out;
  })()`);
  console.log('  movement: ' + JSON.stringify(move));
  check('W walks forward, away from the camera', move.forwardDot > 0.9 && move.moved > 0.25,
    'dot ' + move.forwardDot + ' over ' + move.moved + ' m');
  check('D strafes to the camera right', move.rightDot > 0.9, 'dot ' + move.rightDot);

  /* ---------------- the trigger: click to shoot ---------------- */
  const shoot = await evaluate(`(function () {
    var p = Player, out = {};
    var spot = World.lootPoints[3];
    p.pos.set(spot.x, World.heightAt(spot.x, spot.z), spot.z);
    p.alive = true; p.hp = 100;
    p.weapons = [{ id: 'pistol', mag: 15 }];
    p.curSlot = 0; p.reloadT = 0; p.nextShotT = 0; p.ammoReserve.light = 60;
    Game.update(0.02);
    Input.locked = true;
    var mag0 = p.currentWeapon().mag;
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    out.semiAutoFired = mag0 - p.currentWeapon().mag;
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    /* an automatic: one round on the press, more while held, none after release */
    p.weapons = [{ id: 'smg', mag: 32 }];
    p.nextShotT = 0;
    var auto0 = p.currentWeapon().mag;
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    out.autoFirst = auto0 - p.currentWeapon().mag;
    for (var i = 0; i < 20; i++) Game.update(0.02);
    out.autoHeld = auto0 - p.currentWeapon().mag;
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    for (var i = 0; i < 20; i++) Game.update(0.02);
    out.autoReleased = auto0 - p.currentWeapon().mag;
    return out;
  })()`);
  console.log('  trigger: ' + JSON.stringify(shoot));
  check('a semi-auto pistol fires on click (the reported bug)', shoot.semiAutoFired === 1,
    'mag -' + shoot.semiAutoFired);
  check('an automatic fires exactly once on the press frame', shoot.autoFirst === 1, shoot.autoFirst);
  check('an automatic keeps firing while the button is held', shoot.autoHeld > 2,
    shoot.autoHeld + ' rounds');
  check('releasing the mouse stops the fire', shoot.autoReleased === shoot.autoHeld,
    shoot.autoHeld + ' -> ' + shoot.autoReleased);

  /* ---------------- model visibility rules ---------------- */
  const vis = await evaluate(`(function () {
    var p = Player, out = {};
    var find = function () {
      var g = null;
      App.scene.traverse(function (o) { if (o.isGroup && o.children.length >= 7 && !g) g = o; });
      return g;
    };
    p.ads = true; p.weapons = [{ id: 'sniper', mag: 5 }];
    Game.render(0.05);
    out.scopedHidden = !find().visible;
    p.ads = false; p.weapons = [{ id: 'ar', mag: 30 }];
    Game.render(0.05);
    out.adsVisible = find().visible;
    var wasAlive = p.alive;
    p.alive = false;
    Game.render(0.05);
    out.deadHidden = !find().visible;
    p.alive = wasAlive;
    Game.render(0.05);
    out.backVisible = find().visible;
    return out;
  })()`);
  console.log('  visibility: ' + JSON.stringify(vis));
  check('the character hides while scoped so the scope stays clear', vis.scopedHidden === true);
  check('the character is visible while just aiming', vis.adsVisible === true);
  check('the character is hidden when dead', vis.deadHidden === true);
  check('the character comes back when alive again', vis.backVisible === true);
};
