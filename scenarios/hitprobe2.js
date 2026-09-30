// Minimal probe of Hit.damage's guard behaviour.
module.exports = async function hitprobe2(ctx) {
  const { evaluate, check, sleep } = ctx;
  await evaluate(`document.getElementById('btnPlay').click(); 'go'`);
  await sleep(1000);

  const info = await evaluate(`(function () {
    var b = BOTS[0];
    var fake = { alive: true, hp: 100, shield: 0, helmetTier: 0, vestTier: 0, isPlayer: false,
                 name: 'FAKE', pos: { x: 0, y: 0, z: 0 }, index: 0 };
    var guardWouldReturn = (!b || !b.alive || 9999 <= 0);
    var out = {
      source: Hit.damage.toString().slice(0, 160),
      hasOwnDamage: Object.prototype.hasOwnProperty.call(Hit, 'damage'),
      botAlive: b.alive, botHpType: typeof b.hp, botHp: b.hp,
      guardWouldReturn: guardWouldReturn,
      appState: App.state,
      fakeRet: Hit.damage(fake, 50, {}),
      fakeHp: fake.hp, fakeAlive: fake.alive
    };
    return out;
  })()`);
  console.log(JSON.stringify(info, null, 1));
  check('guard does not short-circuit', info.guardWouldReturn === false, info.guardWouldReturn);
  check('damage on a plain object works', info.fakeRet === 50 && info.fakeHp === 50,
    info.fakeRet + ' / hp ' + info.fakeHp);

  const live = await evaluate(`(function () {
    var b = BOTS[1];
    var before = { hp: b.hp, alive: b.alive };
    var ret = Hit.damage(b, 137, { weapon: 'probe' });
    return { before: before, ret: ret, hp: b.hp, alive: b.alive };
  })()`);
  console.log('live bot: ' + JSON.stringify(live));
  check('a lethal hit kills a real bot', live.alive === false && live.hp === 0,
    JSON.stringify(live));
};
