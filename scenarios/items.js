// Item bars + shield + bot accuracy: the HUD bars show 3D model icons rather
// than names, the character carries a visible shield bubble, and bots miss a
// lot more than they used to.
module.exports = async function items(ctx) {
  const { evaluate, check, sleep } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1400);

  /* ---------------- the 3D item icons ---------------- */
  const icons = await evaluate(`(function () {
    var keys = ['pistol','shotgun','smg','burst','ar','lmg','sniper','launcher',
                'ammo','bandage','medkit','shield','helmet','vest','nade'];
    var missing = [], sizes = {};
    for (var i = 0; i < keys.length; i++) {
      var src = ItemIcons.get(keys[i]);
      if (!src) { missing.push(keys[i]); continue; }
      sizes[keys[i]] = src.length;
    }
    return { missing: missing, count: keys.length - missing.length,
             arPrefix: (ItemIcons.get('ar') || '').slice(0, 22),
             arBytes: sizes.ar || 0, emptyKey: ItemIcons.get('nonsense') };
  })()`);
  console.log('  icons: ' + JSON.stringify(icons));
  check('every weapon and consumable has a baked 3D icon', icons.count === 15,
    icons.count + '/15 (' + (icons.missing.join(',') || 'none missing') + ')');
  check('icons are real rendered images', icons.arPrefix.indexOf('data:image/png') === 0 &&
    icons.arBytes > 800, icons.arBytes + ' bytes for the AR');
  check('an unknown key yields null (text fallback path)', icons.emptyKey === null);

  /* the AR icon must differ from the pistol icon: they are different models */
  const distinct = await evaluate(`(function () {
    var a = ItemIcons.get('ar'), b = ItemIcons.get('pistol'), c = ItemIcons.get('sniper');
    return { arVsPistol: a !== b, arVsSniper: a !== c, pistolVsSniper: b !== c };
  })()`);
  check('each weapon renders its own distinct model', distinct.arVsPistol &&
    distinct.arVsSniper && distinct.pistolVsSniper, JSON.stringify(distinct));

  /* ---------------- the HUD bars ---------------- */
  const bars = await evaluate(`(function () {
    var p = Player;
    p.weapons = [{ id: 'ar', mag: 30 }, { id: 'sniper', mag: 5 }, null, null, null];
    p.curSlot = 1;
    p.inv.bandage = 2; p.inv.medkit = 1; p.inv.shield = 3; p.inv.nade = 1;
    Game.update(0.05);
    var slots = document.querySelectorAll('#slotRow .slot');
    var out = { slots: slots.length, slotDetail: [] };
    for (var i = 0; i < slots.length; i++) {
      var img = slots[i].querySelector('img');
      var span = slots[i].querySelector('span');
      out.slotDetail.push({
        hasImg: !!img,
        isPng: !!(img && img.getAttribute('src') &&
                  img.getAttribute('src').indexOf('data:image/png') === 0),
        src: img && img.getAttribute('src') ? img.getAttribute('src').slice(0, 15) : null,
        imgVisible: img ? img.style.display !== 'none' : false,
        spanVisible: span ? span.style.display !== 'none' : false,
        spanText: span ? span.textContent : '',
        alt: img ? img.alt : ''
      });
    }
    var cons = document.querySelectorAll('#consumRow .cons');
    out.consumables = [];
    for (var i = 0; i < cons.length; i++) {
      out.consumables.push({
        text: cons[i].textContent.trim(),
        imgs: cons[i].querySelectorAll('img').length,
        imgShown: (function () {
          var im = cons[i].querySelector('img');
          return im ? im.style.display !== 'none' : false;
        })()
      });
    }
    out.consumRowText = document.getElementById('consumRow').textContent;
    out.slotRowText = document.getElementById('slotRow').textContent;
    out.labelHosts = document.querySelectorAll('#lootLabels, .llab').length;
    return out;
  })()`);
  console.log('  bars: ' + JSON.stringify(bars.slotDetail));
  console.log('  consumables: ' + JSON.stringify(bars.consumables));
  check('filled slots show a rendered weapon model',
    bars.slotDetail[0].hasImg && bars.slotDetail[0].imgVisible &&
    bars.slotDetail[0].isPng === true,
    'slot 1 img=' + bars.slotDetail[0].src + ' alt=' + bars.slotDetail[0].alt);
  check('the bar shows no weapon *name* text', bars.slotDetail[0].spanVisible === false &&
    bars.slotDetail[1].spanVisible === false, 'slot text="' + bars.slotRowText.trim() + '"');
  check('the model is still named for accessibility (alt/tooltip)',
    bars.slotDetail[0].alt.length > 3, bars.slotDetail[0].alt);
  check('empty slots stay blank', bars.slotDetail[2].imgVisible === false);
  check('consumables show models plus counts, not names',
    bars.consumables.length === 4 && bars.consumables.every(c => c.imgs === 1 && c.imgShown) &&
    /x2/.test(bars.consumables[0].text) &&
    !/BANDAGE|MEDKIT|SHIELD|NADE/i.test(bars.consumRowText),
    'row text="' + bars.consumRowText.replace(/\s+/g, ' ') + '"');
  check('the old floating loot name tags are gone from the DOM', bars.labelHosts === 0);

  /* ---------------- the shield bubble on the character ---------------- */
  const shield = await evaluate(`(function () {
    var g = null;
    App.scene.traverse(function (o) { if (o.isGroup && o.children.length >= 7 && !g) g = o; });
    if (!g) return { err: 'no character' };
    var bubble = null;
    g.traverse(function (o) {
      if (o.isMesh && o.geometry.type === 'SphereGeometry' && o.material.transparent) bubble = o;
    });
    if (!bubble) return { err: 'no shield bubble on the character' };
    var p = Player, out = { found: true };
    p.alive = true; p.airborne = false;
    p.shield = 0;
    PlayerView.update(0.02, p);
    out.at0 = { visible: bubble.visible, opacity: +bubble.material.opacity.toFixed(3) };
    p.shield = 50;
    PlayerView.update(0.02, p);
    out.at50 = { visible: bubble.visible, opacity: +bubble.material.opacity.toFixed(3),
                 radius: +bubble.scale.x.toFixed(3) };
    p.shield = 100;
    PlayerView.update(0.02, p);
    out.at100 = { visible: bubble.visible, opacity: +bubble.material.opacity.toFixed(3),
                  radius: +bubble.scale.x.toFixed(3) };
    /* it flashes right after the shield eats a hit */
    Game.time = 10;
    p.lastDamageTime = 10;
    PlayerView.update(0.02, p);
    out.flash = +bubble.material.opacity.toFixed(3);
    Game.time = 20;
    PlayerView.update(0.02, p);
    out.settled = +bubble.material.opacity.toFixed(3);
    p.shield = 0;
    PlayerView.update(0.02, p);
    out.hiddenAgain = bubble.visible;
    return out;
  })()`);
  console.log('  shield: ' + JSON.stringify(shield));
  check('the character carries a shield bubble', shield.found === true && !shield.err, shield.err || 'ok');
  check('the bubble is hidden with no shield', shield.at0.visible === false,
    'visible=' + shield.at0.visible);
  check('the bubble appears and grows with shield',
    shield.at50.visible && shield.at100.visible && shield.at100.radius > shield.at50.radius,
    shield.at50.radius + ' -> ' + shield.at100.radius + ' m');
  check('it glows brighter the more shield you have',
    shield.at100.opacity > shield.at50.opacity, shield.at50.opacity + ' -> ' + shield.at100.opacity);
  check('it flashes when the shield absorbs a hit', shield.flash > shield.settled,
    shield.flash + ' vs settled ' + shield.settled);
  check('the bubble disappears when the shield is gone', shield.hiddenAgain === false);

  /* ---------------- bots aim much worse now ---------------- */
  const aim = await evaluate(`(function () {
    /* one live bot, an AR, and the player standing in a lane with a clear line */
    Bots.update = function () {
      entityGrid.clear();
      if (Player.alive) entityGrid.insert(Player.pos.x, Player.pos.z, Player);
      for (var i = 0; i < BOTS.length; i++) if (BOTS[i].alive) entityGrid.insert(BOTS[i].pos.x, BOTS[i].pos.z, BOTS[i]);
      BotView.flush();
    };
    for (var i = 1; i < BOTS.length; i++) { BOTS[i].alive = false; BotView.hide(BOTS[i].index); }
    var b = BOTS[0];
    b.alive = true; b.skill = 0.6; b.aggression = 1;
    b.weapons = [{ id: 'ar', mag: 999 }]; b.weaponId = 'ar'; b.mag = 999;
    b.ammoReserve.medium = 999; b.reloadT = 0; b.fireT = 0; b.burstLeft = 0;
    b.crouch = false; b.helmetTier = 0; b.vestTier = 0;
    /* find a lane where the bot really can see the player 10 m away */
    var lane = null;
    for (var i = 0; i < World.lootPoints.length && !lane; i++) {
      var s = World.lootPoints[i];
      var my = World.heightAt(s.x, s.z - 10);
      if (my < 2.5 || World.heightAt(s.x, s.z) < 2.5) continue;
      if (World.losClear(s.x, my + 1.3, s.z - 10, s.x, World.heightAt(s.x, s.z) + 1.0, s.z)) {
        lane = { bx: s.x, bz: s.z - 10, by: my, px: s.x, pz: s.z, py: World.heightAt(s.x, s.z) };
      }
    }
    if (!lane) return { err: 'no clear lane' };
    Player.pos.set(lane.px, lane.py, lane.pz);
    Player.hp = 1e9; Player.shield = 0; Player.alive = true;
    b.pos.set(lane.bx, lane.by, lane.bz);
    b.target = Player;

    var shots = 0, hits = 0;
    var origFire = Bots.fireAt.bind(Bots);
    Bots.fireAt = function (bot, tgt, dist, dt) {
      var m0 = bot.mag;
      origFire(bot, tgt, dist, dt);
      if (bot.mag < m0) shots++;
    };
    var origDamage = Hit.damage.bind(Hit);
    Hit.damage = function (e, amount, opts) {
      if (e === Player && opts && opts.attacker === b) hits++;
      return origDamage(e, amount, opts);
    };
    for (var i = 0; i < 4000; i++) {
      b.mag = 999;
      b.fireT = 0; b.burstLeft = 0;
      Bots.fireAt(b, Player, 10, 0.05);
    }
    Bots.fireAt = origFire;
    Hit.damage = origDamage;
    return { shots: shots, hits: hits, rate: +(hits / Math.max(1, shots)).toFixed(3),
             bakedCap: 0.45, accuracy: CONFIG.BOT_ACCURACY_PLAYER };
  })()`);
  console.log('  bot aim at 10 m: ' + JSON.stringify(aim));
  check('bots do fire at the player', aim.shots > 200, aim.shots + ' shots');
  check('bot accuracy against the human is low (they miss a lot)',
    aim.rate <= aim.bakedCap + 0.03, 'hit rate ' + Math.round(aim.rate * 100) + '% at 10 m');
  check('bots still land some shots (not harmless)', aim.rate > 0.02,
    Math.round(aim.rate * 100) + '% hit rate');
};
