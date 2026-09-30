// Bots: 100 health, and a shield potion drunk the way the player drinks it.
//
// The old behaviour topped a bot's shield up out of nowhere after a delay. Now a
// bot finds a potion, stops, spends CONFIG.SHIELD_TIME on it, and only banks the
// 50 shield when the timer runs out - and losing the drink to a bullet cancels
// it without spending the potion, exactly like Player.cancelUse.
module.exports = async function botheal(ctx) {
  const { evaluate, check } = ctx;

  await evaluate(`App.startMatch(); 1`);

  const hp = await evaluate(`(function () {
    var out = { maxHp: CONFIG.BOT_MAX_HP, playerMax: CONFIG.MAX_HP, off: 0, counts: {} };
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (b.maxHp !== CONFIG.MAX_HP) out.off++;
      if (b.hp !== b.maxHp) out.off++;
      if (b.shield !== 0) out.counts.startingShield = (out.counts.startingShield || 0) + 1;
      if (b.weaponId) out.counts.armed = (out.counts.armed || 0) + 1;
    }
    out.botCount = BOTS.length;
    /* and the max never drifts: heal to the cap and check it stops there */
    var probe = BOTS[0];
    probe.hp = 10;
    probe.inv.medkit = 1;
    probe.use = null;
    Bots.startUse(probe, 'medkit');
    out.medkitTime = probe.use.total;
    Bots.useTick(probe, CONFIG.MEDKIT_TIME + 0.01);
    out.healed = probe.hp;
    probe.hp = probe.maxHp;
    probe.inv.bandage = 1;
    probe.use = null;
    Bots.startUse(probe, 'bandage');
    Bots.useTick(probe, CONFIG.BANDAGE_TIME + 0.01);
    out.capped = probe.hp;
    return out;
  })()`);
  console.log('  hp: ' + JSON.stringify(hp));
  check('bots and the player share the 100 pool',
    hp.maxHp === 100 && hp.playerMax === 100, hp.maxHp + '/' + hp.playerMax);
  check('no bot starts over or under its health', hp.off === 0,
    hp.off + ' of ' + hp.botCount + ' off the pool');
  check('no bot starts with free shield', !hp.counts.startingShield && !hp.counts.armed,
    JSON.stringify(hp.counts));
  check('a medkit takes its full use time', Math.abs(hp.medkitTime - 6) < 0.01, hp.medkitTime);
  check('healing never goes past 100', hp.healed === 100 && hp.capped === 100,
    hp.healed + '/' + hp.capped);

  const drink = await evaluate(`(function () {
    var out = {};
    var b = BOTS[0];
    b.alive = true; b.busJumped = true; b.state = 'loot';
    b.pos.set(0, World.groundAt(0, 0, 40), 0);
    b.vel.set(0, 0, 0);
    b.hp = b.maxHp;
    b.shield = 0;
    b.inv.shield = 1;
    b.inv.bandage = 0; b.inv.medkit = 0;
    b.use = null;
    b.healT = 0;
    b.moveTarget.x = b.pos.x; b.moveTarget.z = b.pos.z;

    out.wants = Bots.wantsHeal(b);
    out.kind = Bots.pickUseKind(b);
    out.started = Bots.startUse(b, out.kind);
    out.total = b.use ? b.use.total : -1;
    out.shieldTime = CONFIG.SHIELD_TIME;
    /* a bot cannot start a second item while one is on the go */
    out.doubleStart = Bots.startUse(b, 'shield');

    /* half way through: the shield must NOT be there yet */
    Bots.useTick(b, CONFIG.SHIELD_TIME * 0.5);
    out.shieldHalfway = b.shield;
    out.stillDrinking = !!b.use;
    Bots.useTick(b, CONFIG.SHIELD_TIME * 0.51);
    out.shieldAfter = b.shield;
    out.potionsLeft = b.inv.shield;
    out.done = b.use === null;

    /* taking a hit cancels it, and the potion is not spent */
    b.inv.shield = 1; b.shield = 0; b.use = null; b.healT = 0;
    Bots.startUse(b, 'shield');
    out.drinking2 = !!b.use;
    Hit.damage(b, 5, { attacker: Player, weapon: 'probe' });
    out.cancelled = b.use === null;
    out.shieldAfterHit = b.shield;
    out.potionsAfterHit = b.inv.shield;

    /* and the FSM really reaches the drink on its own: park a hurt bot in an
       empty part of the map with a potion and let it live a few seconds */
    var c = BOTS[1];
    c.alive = true; c.busJumped = true; c.state = 'loot';
    c.pos.set(0, World.groundAt(0, 0, 40), 0);
    c.hp = c.maxHp;
    c.shield = 0;
    c.inv.shield = 2;
    c.inv.bandage = 0; c.inv.medkit = 0;
    c.use = null;
    c.healT = 0;
    c.weaponId = null;
    c.moveTarget.x = c.pos.x; c.moveTarget.z = c.pos.z;
    var entered = null, banked = 0;
    for (var f = 0; f < 900; f++) {
      Bots.step(c, 1 / 60);
      if (c.use && !entered) entered = c.use.kind;
      if (c.shield > 0) { banked = c.shield; break; }
    }
    out.fsmEntered = entered;
    out.fsmShield = banked;
    out.fsmPotions = c.inv.shield;
    return out;
  })()`);
  console.log('  drink: ' + JSON.stringify(drink));
  check('a bot carrying shield wants to drink it',
    drink.wants === true && drink.kind === 'shield' && drink.started === true, drink.kind);
  check('drinking takes the potion\'s full use time',
    Math.abs(drink.total - drink.shieldTime) < 0.01, drink.total + 's vs ' + drink.shieldTime + 's');
  check('one item at a time', drink.doubleStart === false);
  check('nothing lands until the drink finishes',
    drink.shieldHalfway === 0 && drink.stillDrinking === true, 'shield ' + drink.shieldHalfway);
  check('the drink banks a full potion and spends it',
    drink.shieldAfter === 50 && drink.potionsLeft === 0 && drink.done,
    'shield ' + drink.shieldAfter + ', potions ' + drink.potionsLeft);
  check('taking a hit cancels the drink and keeps the potion',
    drink.cancelled && drink.shieldAfterHit === 0 && drink.potionsAfterHit === 1,
    'cancelled=' + drink.cancelled + ' shield=' + drink.shieldAfterHit +
    ' potions=' + drink.potionsAfterHit);
  check('the AI reaches the drink on its own',
    drink.fsmEntered === 'shield' && drink.fsmShield === 50,
    'walked into ' + drink.fsmEntered + ', ended on ' + drink.fsmShield + ' shield');
  return { hp, drink };
};
