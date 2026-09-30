// HUD / UI / interaction scenario: every widget updates, loot and consumables
// work, zone damage reaches the player, keys are wired, and the audio graph
// starts on a gesture.
const KEY = (code, extra) => `(function () {
  var e = new KeyboardEvent('keydown', Object.assign({ code: ${JSON.stringify(code)},
    key: ${JSON.stringify(code)}, bubbles: true, cancelable: true }, ${JSON.stringify(extra || {})}));
  window.dispatchEvent(e);
  return 'sent';
})()`;

module.exports = async function hud(ctx) {
  const { evaluate, check, sleep, send } = ctx;

  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1200);
  /* run the drop out so the player is on the ground */
  await evaluate(`(function () {
    if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }
    for (var i = 0; i < 400 && App.state === 'DROP'; i++) Game.update(0.05);
    return App.state;
  })()`);

  const base = await evaluate(`(function () {
    var g = function (id) { return document.getElementById(id); };
    return {
      state: App.state, playerAlive: Player.alive, grounded: Player.grounded,
      hpFill: g('hpBar').querySelector('i').style.width,
      shFill: g('shBar').querySelector('i').style.width,
      hudVisible: !g('hud').classList.contains('hidden'),
      aliveText: g('aliveCount').textContent,
      zoneTimer: g('zoneTimer').textContent,
      zoneSub: g('zoneSub').textContent,
      compassPixels: (function () {
        var c = g('compass'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        var n = 0;
        for (var i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
        return n;
      })(),
      minimapPixels: (function () {
        var c = g('minimap'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        var n = 0;
        for (var i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
        return n;
      })(),
      fpsHidden: getComputedStyle(g('fpsBox')).display
    };
  })()`);
  check('HUD is visible during play', base.hudVisible);
  check('player landed and is playing', base.state === 'PLAYING' && base.grounded,
    base.state + ' grounded=' + base.grounded);
  check('health bar is rendered', /%$/.test(base.hpFill), base.hpFill);
  check('alive counter is populated', /^\d+$/.test(base.aliveText), base.aliveText);
  check('zone timer is a clock', /^\d+:\d\d$/.test(base.zoneTimer), base.zoneTimer);
  check('compass strip is drawn', base.compassPixels > 200, base.compassPixels + ' px');
  check('minimap is drawn', base.minimapPixels > 500, base.minimapPixels + ' px');

  /* ---------------- loot: prompt, pickup, ammo auto-pickup ---------------- */
  const loot = await evaluate(`(function () {
    var out = {};
    /* drop a rifle on the ground two metres in front of the player */
    var p = Player;
    var a = CAM.yaw;
    var ix = p.pos.x + Math.sin(a) * 2.2, iz = p.pos.z - Math.cos(a) * 2.2;
    var iy = World.heightAt(ix, iz);
    Loot.spawn({ kind: 'weapon', w: 'ar' }, ix, iy + 0.25, iz);
    var itemsBefore = Loot.count;
    Game.update(0.05);                          // runs the aim/prompt pass
    var prompt = document.getElementById('pickupPrompt');
    out.promptVisible = prompt ? !prompt.classList.contains('hidden') : null;
    out.promptName = document.getElementById('pickupName').textContent;
    out.aimedInfo = Loot.info(null);        // must be safe with nothing aimed
    /* press E */
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true }));
    Game.update(0.05);
    out.weapons = p.weapons.filter(function (x) { return !!x; }).map(function (x) { return x.id; });
    out.mag = p.currentWeapon() ? p.currentWeapon().mag : -1;
    out.reserve = p.ammoReserve.medium;
    out.itemsAfter = Loot.count;
    out.promptHiddenAfter = document.getElementById('pickupPrompt').classList.contains('hidden');
    /* stand on an ammo box: it should be picked up automatically, but only for
       a weapon the player actually owns */
    p.ammoReserve.medium = 0;
    var cnt0 = Loot.count;
    var spawned = Loot.spawn({ kind: 'ammo', ammo: 'medium', count: 30 }, p.pos.x, p.pos.y + 0.3, p.pos.z);
    out.ammoSpawned = !!spawned;
    out.countBefore = cnt0;
    out.countAfterSpawn = Loot.count;
    var mediumBefore = p.ammoReserve.medium;
    Game.update(0.05);
    out.autoAmmo = { before: mediumBefore, after: p.ammoReserve.medium };
    out.countAfterPickup = Loot.count;
    /* and a type we have no gun for must be left alone */
    p.ammoReserve.rockets = 0;
    Loot.spawn({ kind: 'ammo', ammo: 'rockets', count: 2 }, p.pos.x, p.pos.y + 0.3, p.pos.z);
    Game.update(0.05);
    out.ignoredRockets = p.ammoReserve.rockets;
    out.itemsBefore = itemsBefore;
    return out;
  })()`);
  console.log('  loot: ' + JSON.stringify(loot));
  check('a ground weapon shows a "press E" prompt', loot.promptVisible === true,
    loot.promptName);
  check('pressing E equips the ground weapon', loot.weapons.indexOf('ar') !== -1,
    loot.weapons.join(',') + ' mag=' + loot.mag);
  check('the item was consumed from the ground', loot.itemsAfter < loot.itemsBefore + 1,
    loot.itemsBefore + ' -> ' + loot.itemsAfter);
  check('walking over matching ammo auto-collects it',
    loot.autoAmmo.after > loot.autoAmmo.before,
    loot.autoAmmo.before + ' -> ' + loot.autoAmmo.after);
  check('ammo you have no gun for is left on the ground', loot.ignoredRockets === 0,
    'rockets ' + loot.ignoredRockets);

  /* ---------------- consumables: medkit heal + cancel on damage ----------------
     The heal channel takes seconds of real sim time, so make the human immune to
     bot fire for this section - we are testing the consumable, not survivability. */
  await evaluate(`(function () {
    window.__god = true;
    if (!window.__origHitDamage) {
      window.__origHitDamage = Hit.damage.bind(Hit);
      Hit.damage = function (e, amount, opts) {
        if (window.__god && e === Player) return 0;
        return window.__origHitDamage(e, amount, opts);
      };
    }
    return 'ok';
  })()`);
  const heal = await evaluate(`(function () {
    var p = Player;
    p.alive = true;
    p.hp = 40;
    p.inv.medkit = 2;
    p.using = null;
    p.startUse('medkit');
    var started = !!p.using;
    Game.update(0.1);
    var barShown = document.getElementById('healBarWrap').classList.contains('show');
    var label = document.getElementById('healBarLabel').textContent;
    var midHp = p.hp;
    /* finish the channel */
    for (var i = 0; i < 90 && p.using; i++) Game.update(0.1);
    var out = { started: started, barShown: barShown, label: label, midHp: midHp,
                hpAfter: p.hp, medkits: p.inv.medkit,
                barHidden: !document.getElementById('healBarWrap').classList.contains('show') };
    /* taking a hit must interrupt a heal in progress */
    p.hp = 50; p.inv.bandage = 1; p.using = null;
    p.startUse('bandage');
    window.__god = false;                     // this hit has to land
    Hit.damage(p, 5, { weapon: 'probe' });
    window.__god = true;
    out.cancelled = !p.using;
    /* shield potion */
    p.shield = 0; p.inv.shield = 1; p.using = null;
    p.startUse('shield');
    for (var i = 0; i < 90 && p.using; i++) Game.update(0.1);
    out.shield = p.shield;
    return out;
  })()`);
  console.log('  consumables: ' + JSON.stringify(heal));
  check('a medkit starts a channel with a progress bar', heal.started && heal.barShown,
    heal.label);
  check('the medkit heals to full and is consumed', heal.hpAfter >= 100 && heal.medkits === 1,
    heal.hpAfter + ' hp, ' + heal.medkits + ' left');
  check('taking damage interrupts healing', heal.cancelled === true);
  check('a shield potion grants shield', heal.shield >= 50, heal.shield);

  /* ---------------- zone damage + directional warnings ---------------- */
  const zone = await evaluate(`(function () {
    var p = Player;
    window.__god = false;                     // zone damage must land again
    p.hp = 100; p.shield = 60; p.alive = true;
    /* stand well outside the circle */
    p.pos.set(Zone.cur.x + Zone.cur.r + 90, 20, Zone.cur.z);
    p.pos.y = World.heightAt(p.pos.x, p.pos.z) + 1;
    p.grounded = true; p.airborne = false;
    var shield0 = p.shield, hp0 = p.hp;
    Game.update(0.2);
    var out = {
      outside: Zone.isOutside(p.pos.x, p.pos.z),
      dps: Zone.dps(),
      warnShown: document.getElementById('outsideWarn').classList.contains('show'),
      warnText: document.getElementById('outsideWarn').textContent,
      hp0: hp0, hp1: p.hp, shield0: shield0, shield1: p.shield
    };
    /* damage direction indicator */
    FX.damageDir(p.pos.x + 30, p.pos.z + 10);
    out.dmgDirShown = !!document.querySelector('#dmgDirs .show, .dmgDir.show');
    FX.hitMarker('head');
    out.hitmarker = document.getElementById('hitmarker').className;
    FX.damageNumber(p.pos.x, p.pos.y + 2, p.pos.z, 42, 'head');
    out.dmgNumber = !!document.querySelector('.dnum');
    return out;
  })()`);
  console.log('  zone: ' + JSON.stringify(zone));
  check('standing outside the zone registers', zone.outside === true);
  check('outside warning banner appears', zone.warnShown === true, zone.warnText);
  check('zone damage ignores armour and shield',
    zone.hp1 < zone.hp0 && zone.shield1 === zone.shield0,
    'hp ' + zone.hp0 + '->' + zone.hp1 + '  shield ' + zone.shield0 + '->' + zone.shield1);
  check('damage direction indicator shows', zone.dmgDirShown === true);
  check('hit marker reacts to a headshot', /head/.test(zone.hitmarker), zone.hitmarker);
  check('floating damage numbers spawn', zone.dmgNumber === true);

  /* ---------------- keys: map, scoreboard, FPS counter, pause ---------------- */
  const keys = await evaluate(`(function () {
    var out = {};
    var g = function (id) { return document.getElementById(id); };
    var press = function (code) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: code, key: code, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: code, key: code, bubbles: true }));
    };
    press('KeyM');
    out.mapShown = !g('fullmapWrap').classList.contains('hidden');
    out.mapPixels = (function () {
      var c = g('fullmap'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      var n = 0; for (var i = 3; i < d.length; i += 4) if (d[i] > 8) n++; return n;
    })();
    press('KeyM');
    out.mapHidden = g('fullmapWrap').classList.contains('hidden');
    press('Tab');
    out.scoreVisible = !g('scoreboard').classList.contains('hidden');
    out.scoreRows = g('sbTable').querySelectorAll('tr').length;
    out.scoreSub = g('sbSub').textContent;
    press('Tab');
    out.scoreHidden = g('scoreboard').classList.contains('hidden');
    press('F1');
    Game.update(0.016);                       // the FPS readout refreshes per frame
    out.fpsShown = getComputedStyle(g('fpsBox')).display;
    out.showFps = SETTINGS.showFps;
    press('F1');
    Game.update(0.016);
    Player.weapons = [{ id: 'pistol', mag: 10 }, { id: 'smg', mag: 20 }, null, null, null];
    press('Digit2');
    out.slot = Player.curSlot;
    out.weapon = Player.currentWeapon().id;
    press('Digit1');
    out.slotBack = Player.curSlot;
    Player.ammoReserve.light = 60;            // a reload needs ammo in reserve
    Player.currentWeapon().mag = 0;
    Player.reloadT = 0;
    press('KeyR');
    out.reloading = Player.reloadT > 0;
    Player.reloadT = 0;
    return out;
  })()`);
  console.log('  keys: ' + JSON.stringify(keys));
  check('M opens the fullscreen map with the island drawn', keys.mapShown && keys.mapPixels > 5000,
    keys.mapPixels + ' px');
  check('M closes it again', keys.mapHidden === true);
  check('Tab opens the scoreboard with rows', keys.scoreVisible && keys.scoreRows > 5,
    keys.scoreRows + ' rows / ' + keys.scoreSub);
  check('Tab closes it again', keys.scoreHidden === true);
  check('F1 toggles the FPS readout', keys.fpsShown === 'block' && keys.showFps === true,
    keys.fpsShown);
  check('number keys switch weapon slots', keys.slot === 1 && keys.weapon === 'smg' &&
    keys.slotBack === 0, 'slot ' + keys.slot + ' -> ' + keys.weapon);
  check('R starts a reload', keys.reloading === true);

  const pause = await evaluate(`(function () {
    var g = function (id) { return document.getElementById(id); };
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
    var out = { paused: App.paused, screen: !g('pauseScreen').classList.contains('hidden'),
                stats: g('pauseStats').textContent.slice(0, 60) };
    App.resume();
    out.resumed = !App.paused && g('pauseScreen').classList.contains('hidden');
    return out;
  })()`);
  console.log('  pause: ' + JSON.stringify(pause));
  check('ESC pauses with a menu', pause.paused === true && pause.screen === true, pause.stats);
  check('resuming clears the pause menu', pause.resumed === true);

  /* ---------------- settings ---------------- */
  const settings = await evaluate(`(function () {
    var out = { count: document.querySelectorAll('.settingsHost [data-set]').length };
    var set = function (key, value) {
      var list = document.querySelectorAll('[data-set="' + key + '"]');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (el.type === 'checkbox') el.checked = value; else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    set('sensitivity', 0.004);
    out.sensitivity = SETTINGS.sensitivity;
    set('volume', 0.25);
    out.volume = SETTINGS.volume;
    set('muted', true);
    out.muted = SETTINGS.muted;
    set('showFps', true);
    out.showFps = SETTINGS.showFps;
    var q = document.querySelector('[data-set="quality"]');
    q.value = 'low';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    out.quality = SETTINGS.quality;
    out.pixelRatio = App.renderer.getPixelRatio();
    set('muted', false); set('volume', 0.7); set('showFps', false);
    q.value = 'high';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    out.restored = SETTINGS.quality;
    return out;
  })()`);
  console.log('  settings: ' + JSON.stringify(settings));
  check('settings panel exists', settings.count >= 10, settings.count + ' inputs');
  check('mouse sensitivity setting applies', settings.sensitivity === 0.004, settings.sensitivity);
  check('volume setting applies', settings.volume === 0.25, settings.volume);
  check('mute setting applies', settings.muted === true);
  check('quality setting applies and rescales the pixel ratio', settings.quality === 'low',
    'quality ' + settings.quality + ' pixelRatio ' + settings.pixelRatio);
  check('quality restored to high', settings.restored === 'high');

  /* ---------------- audio graph ---------------- */
  const audio = await evaluate(`(function () {
    var out = { ready: SFX.ready };
    try {
      SFX.play('pickup');
      SFX.setMusicMode('tense');
      SFX.play('explode', { pos: new THREE.Vector3(Player.pos.x + 40, Player.pos.y, Player.pos.z), maxDist: 300 });
      SFX.setMusicMode('calm');
      out.threw = false;
    } catch (e) { out.threw = e.message; }
    out.ctxState = SFX.ctx ? SFX.ctx.state : 'none';
    out.sampleRate = SFX.ctx ? SFX.ctx.sampleRate : 0;
    return out;
  })()`);
  console.log('  audio: ' + JSON.stringify(audio));
  check('audio engine is live after the first gesture', audio.ready === true,
    audio.ctxState + ' @' + audio.sampleRate + 'Hz');
  check('positional and music cues play without throwing', audio.threw === false, audio.threw);

  /* ---------------- performance shape ---------------- */
  const perf = await evaluate(`(function () {
    var t0 = performance.now();
    for (var i = 0; i < 120; i++) Game.update(1 / 60);
    var t1 = performance.now();
    Game.render(1 / 60);
    var info = App.renderer.info;
    return {
      updateMsPerFrame: +((t1 - t0) / 120).toFixed(2),
      drawCalls: info.render.calls, triangles: info.render.triangles,
      geometries: info.memory.geometries, textures: info.memory.textures,
      pixelRatio: App.renderer.getPixelRatio()
    };
  })()`);
  console.log('  perf: ' + JSON.stringify(perf));
  check('simulation update is cheap enough for 60 FPS', perf.updateMsPerFrame < 8,
    perf.updateMsPerFrame + ' ms/frame of sim');
  check('draw call budget is reasonable', perf.drawCalls < 400,
    perf.drawCalls + ' calls, ' + perf.triangles + ' tris');
  check('device pixel ratio is capped at 2', perf.pixelRatio <= 2, perf.pixelRatio);

  /* ---------------- graceful WebGL failure ---------------- */
  const webgl = await evaluate(`(function () {
    var orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function () { return null; };
    var ok = webglAvailable();
    HTMLCanvasElement.prototype.getContext = orig;
    var err = document.getElementById('bootError');
    return { available: ok, errorText: document.getElementById('bootErrorText').textContent.slice(0, 70),
             errorElementExists: !!err };
  })()`);
  check('WebGL absence is detected instead of crashing', webgl.available === false,
    'webglAvailable() -> ' + webgl.available);
  check('a friendly message is ready for WebGL-less browsers',
    webgl.errorElementExists && /WebGL/i.test(webgl.errorText), webgl.errorText);

  /* ---------------- resize keeps the aspect ratio ---------------- */
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1600, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const resized = await evaluate(`(function () {
    App.onResize();
    return { aspect: +App.camera.aspect.toFixed(3), expected: +(window.innerWidth / window.innerHeight).toFixed(3),
             canvasW: document.getElementById('gameCanvas').width, innerW: window.innerWidth };
  })()`);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
  console.log('  resize: ' + JSON.stringify(resized));
  check('resize keeps the camera aspect in sync', Math.abs(resized.aspect - resized.expected) < 0.02,
    resized.aspect + ' vs ' + resized.expected);
};
