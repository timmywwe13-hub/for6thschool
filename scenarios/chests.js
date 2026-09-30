// Chests, and the fact that guns no longer lie on the open ground.
//
// The whole point of the change is that the ONLY way a firearm reaches anybody -
// player or bot - is out of a chest (or off a body, or out of a supply drop).
// This scenario proves the gate holds: the field table cannot roll a weapon, a
// chest can, a chest spills its contents as ordinary ground items, and a bot
// arms itself by walking to a chest and opening it.
module.exports = async function chests(ctx) {
  const { evaluate, check } = ctx;

  await evaluate(`App.startMatch(); 1`);

  const state = await evaluate(`(function () {
    var out = { chests: Loot.chestCount(), open: 0, placed: 0, onFloor: 0 };
    var list = Loot.chests;
    for (var i = 0; i < list.length; i++) {
      if (list[i].opened) out.open++;
      /* every chest has to sit on the ground, not floating or buried */
      var terr = World.groundAt(list[i].x, list[i].z, list[i].y + 0.6);
      if (Math.abs(terr - list[i].y) < 0.05) out.placed++;
    }
    /* the ground scatter is ammo, heals, armour and frags - never a gun. Roll the
       field table ten thousand times and count. */
    var guns = 0, kinds = {};
    for (var r = 0; r < 10000; r++) {
      var it = Loot.rollItem(0, false);
      if (it.kind === 'weapon') guns++;
      kinds[it.kind] = (kinds[it.kind] || 0) + 1;
    }
    out.guns = guns;
    out.kinds = kinds;
    var withGuns = 0;
    for (var j = 0; j < 4000; j++) if (Loot.rollItem(0, true).kind === 'weapon') withGuns++;
    out.withGuns = withGuns;
    return out;
  })()`);

  console.log('  chests: ' + JSON.stringify(state));
  check('chests are hidden around the island', state.chests >= 100, state.chests + ' chests');
  check('every chest sits on the surface', state.placed === state.chests,
    state.placed + '/' + state.chests + ' level with the ground');
  check('ground loot never rolls a gun', state.guns === 0,
    state.guns + ' weapons in 10000 field rolls');
  check('a chest roll does produce guns', state.withGuns > 400,
    state.withGuns + ' weapons in 4000 chest rolls');
  check('ground loot still carries ammo, heals and armour',
    state.kinds.ammo > 1000 && state.kinds.medkit > 100 &&
    (state.kinds.helmet + state.kinds.vest) > 200,
    JSON.stringify(state.kinds));

  /* ---------------- every chest carries a gun ---------------- */
  const guns = await evaluate(`(function () {
    var out = { guns: 0, opened: 0, kinds: {}, sizes: [] };
    var list = Loot.chests;
    for (var i = 0; i < list.length && out.opened < 80; i++) {
      var ch = list[i];
      if (ch.opened) continue;
      var guns = 0, n = 0;
      var orig = Loot.spawn;
      Loot.spawn = function (item) {
        n++;
        if (item.kind === 'weapon') guns++;
        out.kinds[item.kind] = (out.kinds[item.kind] || 0) + 1;
        return orig.apply(Loot, arguments);
      };
      Loot.openChest(ch, null);
      Loot.spawn = orig;
      out.opened++;
      out.sizes.push(n);
      if (guns > 0) out.guns++;
    }
    out.noGun = out.opened - out.guns;
    return out;
  })()`);
  console.log('  chest contents: ' + JSON.stringify(guns));
  check('every chest that opens contains at least one gun',
    guns.opened > 40 && guns.guns === guns.opened,
    guns.guns + '/' + guns.opened + ' chests had a gun' +
    (guns.noGun ? ' (' + guns.noGun + ' without one)' : ''));

  /* opening a chest: the contents land around it, the lid plays its open animation
     and then shuts itself again once the loot is gone, and the player gets a toast */
  const opened = await evaluate(`(function () {
    var ch = null;
    for (var i = 0; i < Loot.chests.length; i++) if (!Loot.chests[i].opened) { ch = Loot.chests[i]; break; }
    var before = Loot.count;
    var n = Loot.openChest(ch, Player);
    var out = { n: n, spawned: Loot.count - before, opened: ch.opened,
                want: ch.want, dropped: ch.loot.length, lidTime: CONFIG.CHEST_LID_TIME,
                second: Loot.openChest(ch, Player) };
    /* step the lid's own clock: it fully opens inside CHEST_LID_TIME */
    var frames = 0;
    for (var f = 0; f < 120 && ch.open < 1; f++) { Loot.update(1 / 60); frames++; }
    out.lidOpen = +ch.open.toFixed(3);
    out.openFrames = frames;
    out.openSeconds = +(frames / 60).toFixed(2);
    /* take everything it dropped, then let the shut-down countdown run */
    for (var k = 0; k < ch.loot.length; k++) if (ch.loot[k].live) Loot.consume(ch.loot[k]);
    Loot.update(1 / 60);
    out.wantAfterTaken = ch.want;
    for (var g = 0; g < 120 && ch.open > 0; g++) Loot.update(1 / 60);
    out.lidShut = +ch.open.toFixed(3);
    return out;
  })()`);
  console.log('  opening: ' + JSON.stringify(opened));
  check('a chest spills 2-4 items onto the ground',
    opened.n >= 2 && opened.n <= 4, opened.n + ' items');
  check('a chest cannot be opened twice', opened.second === 0, opened.second);
  check('the lid swings open over CHEST_LID_TIME',
    opened.lidOpen === 1 && opened.openSeconds <= opened.lidTime + 0.1,
    opened.lidOpen + ' open after ' + opened.openSeconds + 's (lid time ' + opened.lidTime + 's)');
  check('an emptied chest shuts its lid again',
    opened.wantAfterTaken === 0 && opened.lidShut === 0,
    'want ' + opened.wantAfterTaken + ', lid ' + opened.lidShut);

  /* the model: the baked chest is what is drawn, and the crosshair cracks its lid */
  const model = await evaluate(`(function () {
    var out = Loot.chestInfo;
    var baked = window.CHEST_MODEL;
    out.hasSidecar = !!baked;
    if (baked) {
      out.tris = 0;
      for (var i = 0; i < baked.parts.length; i++) out.tris += baked.parts[i].tris;
      out.lidPart = baked.lid;
      out.texture = /^data:image\\//.test(baked.texture || '');
    }
    /* point the camera at an unopened chest from 2 m away and let the aim pass
       find it: the lid lifts a little as the "come and open me" cue */
    var ch = null;
    for (var k = 0; k < Loot.chests.length; k++) if (!Loot.chests[k].opened) { ch = Loot.chests[k]; break; }
    if (!ch) return out;
    /* the lid mesh is the one whose index count matches the lid part */
    var lidIdx = -1;
    for (var m = 0; m < baked.parts.length; m++) if (baked.parts[m].lift) lidIdx = m;
    var lidMesh = null;
    if (lidIdx >= 0) {
      var want = baked.parts[lidIdx].idx.length;
      var all = App.scene.children;
      for (var a = 0; a < all.length; a++) {
        var o = all[a];
        if (o.isInstancedMesh && o.geometry.index && o.geometry.index.count === want) { lidMesh = o; break; }
      }
    }
    var mm = new THREE.Matrix4();
    function lidPose(target) {
      if (!lidMesh || !target) return 0;
      lidMesh.getMatrixAt(target.idx, mm);
      var e = mm.elements, s = 0;
      for (var i = 0; i < 16; i++) s += e[i];
      return s;
    }
    Player.alive = true;
    /* first with nothing aimed at all: the lid sits closed */
    Player.pos.set(ch.x, World.groundAt(ch.x, ch.z, ch.y + 2), ch.z - 2);
    CAM.pos.set(ch.x + 400, ch.y + 300, ch.z + 400);
    CAM.dir.set(0, -1, 0);
    for (var f = 0; f < 60; f++) Loot.update(1 / 60);
    out.aimedCalm = Loot.aimedChest === ch;
    var calm = lidPose(ch);
    /* then looking straight at the chest's middle (aimed the way the game aims,
       from the camera to the target, so the ray is exactly on it) */
    CAM.pos.set(ch.x, ch.y + 1.2, ch.z - 2.2);
    var adx = ch.x - CAM.pos.x, ady = (ch.y + 0.35) - CAM.pos.y, adz = ch.z - CAM.pos.z;
    CAM.dir.set(adx, ady, adz).normalize();
    for (var g = 0; g < 60; g++) Loot.update(1 / 60);
    var aimed = Loot.aimedChest;
    out.aimed = !!aimed;
    out.sameChest = aimed === ch;
    out.peek = aimed ? +aimed.peek.toFixed(3) : -1;
    out.lidMoved = out.sameChest ? +Math.abs(lidPose(ch) - calm).toFixed(4) : -1;
    return out;
  })()`);
  console.log('  model: ' + JSON.stringify(model));
  check('the chest is built from the baked model',
    model.hasSidecar && model.baked && model.parts >= 4 && model.tris === 806,
    model.source + ', ' + model.parts + ' parts, ' + model.tris + ' tris');
  check('the model ships its texture', model.texture === true);
  check('a chest under the crosshair cracks its lid open',
    model.aimed === true && model.sameChest === true && model.peek > 0.9 && model.lidMoved > 0.01,
    'aimed ' + model.aimed + ', same chest ' + model.sameChest + ', peek ' + model.peek +
    ', lid pose moved ' + model.lidMoved);

  /* a bot has to open a chest itself before it can hold a gun */
  const bot = await evaluate(`(function () {
    App.startMatch();
    var armedAtStart = 0;
    for (var i = 0; i < BOTS.length; i++) if (BOTS[i].weaponId) armedAtStart++;
    var b = BOTS[0];
    b.alive = true; b.state = 'loot'; b.busJumped = true; b.use = null;
    var armed = false, chestsOpened = 0, firstWeapon = null;
    /* Every chest carries a gun now, so the first one the bot reaches should arm
       it - the loop still walks on if some chest were somehow empty, which is
       what the loot FSM does anyway. */
    var used = Object.create(null);
    for (var attempt = 0; attempt < 8 && !armed; attempt++) {
      var ch = null;
      for (var k = 0; k < Loot.chests.length; k++) {
        var c = Loot.chests[k];
        if (c.opened || used[c.idx]) continue;
        ch = c; used[c.idx] = 1; break;
      }
      if (!ch) break;
      b.pos.set(ch.x, World.groundAt(ch.x, ch.z, ch.y + 2), ch.z);
      b.lootFindT = 0;
      for (var f = 0; f < 400 && !armed; f++) {
        Bots.upgradeGear(b, 1 / 60);
        if (ch.opened && !firstWeapon) firstWeapon = ch.opened;
        if (b.weaponId) armed = true;
      }
      if (ch.opened) chestsOpened++;
    }
    return { armedAtStart: armedAtStart, armed: armed, chestsOpened: chestsOpened,
             weapon: b.weaponId, mag: b.mag, openedChests: Loot.chestsOpened() };
  })()`);
  console.log('  bot loot: ' + JSON.stringify(bot));
  check('nobody is handed a gun at spawn', bot.armedAtStart === 0,
    bot.armedAtStart + ' armed bots');
  check('a bot arms itself by opening chests', bot.armed && bot.chestsOpened > 0,
    bot.chestsOpened + ' chests opened, weapon ' + bot.weapon + ' mag ' + bot.mag);
  return { state, opened, bot };
};
