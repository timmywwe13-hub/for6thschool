// The party layer: friends, formats (duos / trios / squads), the 1 v 1, and the
// team rules that make them work - squadmates are not enemies, bullets pass
// through them, the win condition is "no enemy team left", and the friends list
// is real persisted state.
module.exports = async function teams(ctx) {
  const { evaluate, check, sleep } = ctx;

  /* ---------- friends list ---------- */
  const friends = await evaluate(`(function () {
    var out = {};
    Friends.clear();
    out.startsEmpty = Friends.all().length === 0;
    out.addA = Friends.add('SquadMate').ok;
    out.addB = Friends.add('Rival').ok;
    out.dup = Friends.add('squadmate').ok;       // case-insensitive duplicate
    out.self = Friends.add(SETTINGS.name).ok;    // cannot add yourself
    out.blank = Friends.add('   ').ok;
    out.count = Friends.all().length;
    out.isFriend = Friends.isFriend('Rival');
    out.removed = Friends.remove('Rival');
    out.afterRemove = Friends.all().length;
    Friends.add('Rival');                        // put it back for the tests below
    return out;
  })()`);
  console.log('  friends: ' + JSON.stringify(friends));
  check('the friends list starts empty and accepts names',
    friends.startsEmpty && friends.addA && friends.addB, friends.count + ' friends');
  check('duplicate, self and blank adds are refused',
    friends.dup === false && friends.self === false && friends.blank === false);
  check('isFriend and remove work',
    friends.isFriend === true && friends.removed === true && friends.afterRemove === 1,
    friends.afterRemove + ' left');

  /* ---------- formats and the party ---------- */
  const party = await evaluate(`(function () {
    var out = {};
    out.formats = Object.keys(TEAM_SIZES).length;
    Teams.setMode('squad');
    out.squadSize = Teams.teamSize;
    out.partyStart = Teams.partyNames().length;             // just you
    out.added = Teams.addToParty('SquadMate') && Teams.addToParty('Rival') &&
                Teams.addToParty('Third');
    out.noFifth = !Teams.addToParty('Fourth');
    out.partyNow = Teams.partyNames().length;
    Teams.setMode('duo');                                   // trims the party to fit
    out.duoParty = Teams.partyNames().length;
    out.duoSize = Teams.teamSize;
    var plan = Teams.matchPlan();
    out.planTeam = plan.teamSize;
    out.planMates = plan.mates.length;
    out.planBots = plan.botCount;
    out.planEven = (plan.botCount - plan.mates.length) % plan.teamSize === 0;
    out.planCombatants = plan.combatants;
    Teams.setMode('duel');
    var duel = Teams.matchPlan();
    out.duelCombatants = duel.combatants;
    out.duelTeam = duel.teamSize;
    out.duelMates = duel.mates.length;
    out.duelLabel = Teams.teamLabel();
    Teams.setMode('solo');
    var solo = Teams.matchPlan();
    out.soloCombatants = solo.combatants;
    out.soloMates = solo.mates.length;
    return out;
  })()`);
  console.log('  party: ' + JSON.stringify(party));
  check('five formats are defined', party.formats === 5, party.formats + ' formats');
  check('a squad is four, and the party is capped there',
    party.squadSize === 4 && party.added && party.noFifth && party.partyNow === 4,
    party.partyNow + ' in party');
  check('changing format trims the party', party.duoParty === 2 && party.duoSize === 2,
    party.duoParty + ' left');
  check('duos plans teams of two with the friend as a mate',
    party.planTeam === 2 && party.planMates === 1 && party.planEven,
    'mates ' + party.planMates + ' of ' + party.planBots + ' bots');
  check('a 1 v 1 is two combatants, one each',
    party.duelCombatants === 2 && party.duelTeam === 1 && party.duelMates === 0,
    party.duelCombatants + ' combatants');
  check('solo is still the 100 combatant lobby',
    party.soloCombatants === 100 && party.soloMates === 0, party.soloCombatants);

  /* ---------- a real duos match ---------- */
  const duos = await evaluate(`(function () {
    var out = {};
    Teams.setMode('duo');
    Teams.clearParty();
    Teams.addToParty('SquadMate');
    App.startMatch();
    out.combatants = App.totalCombatants;
    out.bots = BOTS.length;
    out.teamSize = Teams.teamSize;
    out.teams = Teams.totalTeams();
    var mate = null;
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (b.isMate) { mate = b; out.mateName = b.name; out.mateTeam = b.team; }
      else if (b.team === 0) out.strayMate = (out.strayMate || 0) + 1;
    }
    out.mateFound = !!mate;
    out.enemyTeams = Teams.enemyTeamsAlive();
    out.playerTeamAlive = Teams.playerTeamAlive();
    /* friendly fire: nothing from the player can touch a mate */
    var before = mate.hp;
    out.dealt = Hit.damage(mate, 40, { attacker: Player, weapon: 'probe' });
    out.mateUnhurt = mate.hp === before;
    /* a bullet that would cross a mate passes straight through it */
    out.hitscanSkipsMate = (function () {
      var t = Hit.hitscan(mate.pos.x - 6, mate.pos.y + 1.2, mate.pos.z, 1, 0, 0, 20, Player);
      return t.bot !== mate;
    })();
    out.stormHits = Hit.damage(mate, 10, { weapon: 'the storm', ignoresArmor: true,
                                           ignoresShield: true, silent: true }) > 0;
    var victim = null;
    for (var j = 0; j < BOTS.length; j++) if (!BOTS[j].isMate) { victim = BOTS[j]; break; }
    out.enemyDamage = Hit.damage(victim, 20, { attacker: mate, weapon: 'probe' }) > 0;
    return out;
  })()`);
  console.log('  duos: ' + JSON.stringify(duos));
  check('duos builds a smaller lobby than solo',
    duos.combatants >= 8 && duos.combatants < 100, duos.combatants + ' combatants');
  check('the friend rides on the player\'s team',
    duos.mateFound && duos.mateName === 'SquadMate' && duos.mateTeam === 0 && !duos.strayMate,
    duos.mateName + ' on team ' + duos.mateTeam);
  check('the field is split into teams of two',
    duos.teamSize === 2 && duos.teams >= 5, duos.teams + ' teams');
  check('enemy teams exclude the player\'s squad',
    duos.enemyTeams === duos.teams - 1,
    duos.enemyTeams + ' enemy teams out of ' + duos.teams);
  check('no friendly fire from the player', duos.dealt === 0 && duos.mateUnhurt,
    'dealt ' + duos.dealt);
  check('bullets pass through a squadmate', duos.hitscanSkipsMate === true);
  check('the storm still bites a squadmate', duos.stormHits === true);
  check('enemies still take damage from your squad', duos.enemyDamage === true);

  /* ---------- the win condition ---------- */
  const win = await evaluate(`(function () {
    var out = {};
    /* thin every enemy team down to one member: the match must NOT be over */
    var killed = 0;
    for (var i = 0; i < BOTS.length; i++) {
      var b = BOTS[i];
      if (b.isMate || !b.alive || b.team === 0) continue;
      var aliveInTeam = 0;
      for (var j = 0; j < BOTS.length; j++) {
        if (BOTS[j].alive && BOTS[j].team === b.team && !BOTS[j].isMate) aliveInTeam++;
      }
      if (aliveInTeam > 1) { Hit.damage(b, 999, { attacker: Player, weapon: 'probe' }); killed++; }
    }
    out.killed = killed;
    out.teamsLeft = Teams.enemyTeamsAlive();
    out.stateMid = App.state;
    out.winMid = App.win;
    /* and now the last of them: the squad wins the match */
    for (var k = 0; k < BOTS.length; k++) {
      var c = BOTS[k];
      if (!c.isMate && c.alive && c.team !== 0) {
        Hit.damage(c, 999, { attacker: Player, weapon: 'probe' });
      }
    }
    out.stateAfter = App.state;
    out.winAfter = App.win;
    out.sub = document.getElementById('victorySub').textContent;
    return out;
  })()`);
  console.log('  win: ' + JSON.stringify(win));
  check('a duos win needs the enemy teams gone, not every bot dead',
    win.teamsLeft >= 1 && win.stateMid !== 'GAME_OVER',
    win.stateMid + ' with ' + win.teamsLeft + ' enemy teams left');
  check('the squad wins when the last enemy team falls',
    win.winAfter === true && win.stateAfter === 'GAME_OVER', win.stateAfter);
  check('the victory screen names the squad', /SQUAD/.test(win.sub), win.sub);


  /* ---------- the 1 v 1 ---------- */
  const duel = await evaluate(`(function () {
    var out = {};
    Teams.setMode('duel');
    App.startMatch();
    out.combatants = App.totalCombatants;
    out.bots = BOTS.length;
    out.mates = 0;
    for (var i = 0; i < BOTS.length; i++) if (BOTS[i].isMate) out.mates++;
    out.teams = Teams.totalTeams();
    out.teamSize = Teams.teamSize;
    out.label = Teams.teamLabel();
    var b = BOTS[0];
    b.busJumped = true; b.alive = true; b.hp = 1;
    Hit.damage(b, 50, { attacker: Player, weapon: 'probe' });
    out.dead = !b.alive;
    out.state = App.state;
    out.win = App.win;
    out.sub = document.getElementById('victorySub').textContent;
    /* and losing it is a loss */
    Teams.setMode('duel');
    App.startMatch();
    var foe = BOTS[0];
    foe.busJumped = true;
    Player.hp = 1;
    Player.alive = true;
    Hit.damage(Player, 50, { attacker: foe, weapon: 'probe' });
    out.playerDead = !Player.alive;
    out.lossState = App.state;
    out.lossWin = App.win;
    out.lossPlacement = document.getElementById('deathPlacement').textContent;
    return out;
  })()`);
  console.log('  duel: ' + JSON.stringify(duel));
  check('a 1 v 1 is you against exactly one opponent',
    duel.combatants === 2 && duel.bots === 1 && duel.mates === 0 && duel.teams === 2,
    duel.combatants + ' combatants, ' + duel.teams + ' teams');
  check('the 1 v 1 label says so', /1 V 1/.test(duel.label), duel.label);
  check('killing the opponent wins the 1 v 1',
    duel.dead && duel.win === true && duel.state === 'GAME_OVER', duel.state);
  check('the victory screen names the duel', /1 OF 2/.test(duel.sub), duel.sub);
  check('losing the 1 v 1 is a loss',
    duel.playerDead && duel.lossState === 'GAME_OVER' && duel.lossWin === false, duel.lossState);
  check('the death screen shows the duel placement', /#\d+ OF 2/.test(duel.lossPlacement),
    duel.lossPlacement);

  /* ---------- back to solo ---------- */
  const back = await evaluate(`(function () {
    Teams.setMode('solo');
    App.startMatch();
    var mates = 0;
    for (var i = 0; i < BOTS.length; i++) if (BOTS[i].isMate) mates++;
    return { mode: Teams.mode, size: Teams.teamSize, combatants: App.totalCombatants,
             bots: BOTS.length, state: App.state, chests: Loot.chestCount(), mates: mates };
  })()`);
  console.log('  back to solo: ' + JSON.stringify(back));
  check('switching back to solo rebuilds the 100 combatant lobby',
    back.mode === 'solo' && back.size === 1 && back.combatants === 100 && back.bots === 99,
    back.combatants + ' combatants');
  check('a solo match has no squadmates', back.mates === 0);
  check('a solo match opens on the bus', back.state === 'BUS', back.state);
  check('a solo match still has its chests', back.chests >= 100, back.chests + ' chests');

  /* ---------- the friends screen, driven the way a player drives it ---------- */
  const ui = await evaluate(`(function () {
    var out = {};
    /* back to the menu with a clean list */
    App.quitToMenu();
    Friends.clear();
    Teams.setMode('duo');
    Teams.clearParty();
    Teams.paint();
    var kick = function (id) { document.getElementById(id).click(); };
    out.startOnMenu = !document.getElementById('startScreen').classList.contains('hidden');
    /* the party bar shows the format chips, the squad and the transport state */
    out.chips = document.querySelectorAll('#partyModeChips .chip').length;
    out.slots = document.querySelectorAll('#partyList .pmember').length;
    out.net = document.getElementById('netState').textContent;
    /* FRIENDS opens the screen */
    kick('btnFriends');
    out.screenOpen = !document.getElementById('friendsScreen').classList.contains('hidden');
    out.menuHidden = document.getElementById('startScreen').classList.contains('hidden');
    /* add a friend through the form */
    var input = document.getElementById('friendNameInput');
    input.value = 'Buddy';
    document.getElementById('friendAddForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    out.added = Friends.isFriend('Buddy');
    out.rows = document.querySelectorAll('#friendList .fRow').length;   // header + one
    /* INVITE puts that friend in the party */
    document.querySelector('#friendList [data-finvite="Buddy"]').click();
    out.inParty = Teams.has('Buddy');
    out.partyBar = document.getElementById('partyList').textContent;
    /* and the 1v1 button sets the format up against them */
    document.querySelector('#friendList [data-fduel="Buddy"]').click();
    out.mode = Teams.mode;
    out.rival = Teams.duelRival;
    out.duelLabel = document.getElementById('fmtMode').textContent;
    out.playLabel = document.getElementById('btnPlay').textContent;
    /* BACK returns to the shelf with everything painted */
    kick('btnFriendsBack');
    out.backOnMenu = !document.getElementById('startScreen').classList.contains('hidden');
    out.friendsClosed = document.getElementById('friendsScreen').classList.contains('hidden');
    /* ---------- with no transport, a request is kept - and said to be ----------
       The bug this covers: "I added a friend and nothing happened". Nothing can
       leave a page with no lobby, so the game has to report that instead of
       claiming the request went. */
    out.kind = Net.kind;
    out.askedAgain = Friends.ask('Buddy');
    Friends.gotAsk('Nobody');                 // one waiting request, to read the header
    Teams.paint();
    out.sub = document.getElementById('friendsSub').textContent;
    out.why = Net.whyOffline();
    /* a message typed while a socket is still opening is held, and goes out on
       open - the other half of the same bug (send() used to drop it) */
    out.held = (function () {
      var flushed = [];
      Net.kind = 'socket';
      Net.socket = { readyState: 0, send: function () { flushed.push('early'); } };
      var said = Net.friendAsk('Held');
      var waiting = Net.queue.length;
      Net.socket = { readyState: 1, send: function (raw) { flushed.push(raw); } };
      Net.flush();
      var left = Net.queue.length;
      Net.socket = null;
      Net.kind = out.kind;
      return { said: said, waiting: waiting, sent: flushed.length, left: left };
    })();
    /* ---------- the link, in a box, and a copy that cannot lie ----------
       The link is in the game to be sent, so it is in a box that selects itself
       (Ctrl+C works where the clipboard API is refused) - and a browser that
       refuses BOTH paths has to say so instead of announcing COPIED. */
    Teams.paint();
    out.linkBox = (function () {
      const box = document.getElementById('inviteLink');
      if (!box) return null;
      const wanted = Net.inviteLink();
      box.click();                        // the click is what selects the whole link
      return { value: box.value, wanted: wanted, readonly: box.readOnly,
               selected: box.selectionEnd - box.selectionStart };
    })();
    out.copy = (function () {
      const realExec = document.execCommand;
      let stubbed = false;
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: function () { return Promise.reject(new Error('denied')); } }
        });
        stubbed = true;
      } catch (e) { /* leave the real clipboard alone */ }
      /* Both stubs have to stay in place until the answer is in: the async
         clipboard refuses in a microtask, so restoring them synchronously would
         put the working fallback back before it was ever tried. */
      const restore = function () {
        try { document.execCommand = realExec; } catch (e) { /* ignore */ }
        try { delete navigator.clipboard; } catch (e) { /* ignore */ }
      };
      let returned = 'not called';
      if (stubbed) {
        document.execCommand = function () { return false; };   // refuse the fallback too
        returned = Net.copyText('isle-royale-link', function (ok) {
          window.__copyReport = ok ? 'copied' : 'blocked';
          restore();
        });
        returned = 'returned ' + returned;
        setTimeout(restore, 3000);
      }
      return { stubbed: stubbed, returned: returned };
    })();
    /* ---------- who is hosting ----------
       One party, one owner, and every machine has to agree on which one it is. A
       guest mirrors the host's roster with itself first, so the party list cannot
       answer it - the name travels on the wire. */
    out.hostName = (function () {
      Teams.guestOf = '';
      Teams.setMode('solo');
      const solo = Teams.hostName();
      Teams.setMode('duo');
      const alone = Teams.hostName();
      Teams.guestOf = 'Moe';
      const guest = Teams.hostName();
      Teams.guestOf = '';
      return { solo: solo, alone: alone, guest: guest };
    })();
    out.hostUi = (function () {
      Teams.setMode('duo');
      Teams.paint();
      const bar = document.getElementById('partyHost');
      const barMine = { text: bar.textContent, cls: bar.className };
      /* two peers, injected: a real second machine is friendsnet's job. Trio (three
         seats, two taken) so the party is genuinely joinable and the only reason
         the guest is not offered is the host rule. */
      Friends.add('PeerHost');
      Friends.add('PeerGuest');
      Net.peers['peerhost'] = { name: 'PeerHost', at: Date.now(), party: ['PeerHost', 'PeerGuest'],
                                mode: 'trio', state: 'MENU', open: true, host: 'PeerHost' };
      Net.peers['peerguest'] = { name: 'PeerGuest', at: Date.now(), party: ['PeerGuest', 'PeerHost'],
                                 mode: 'trio', state: 'MENU', open: true, host: 'PeerHost' };
      Teams.paint();
      const rows = document.querySelectorAll('#friendList .frPlayer');
      let hostRow = '', guestRow = '';
      for (let i = 0; i < rows.length; i++) {
        /* identify the row by the name in <b>, not by the whole text: a guest's
           row names its host too, so /PeerHost/ would match both rows */
        const nameEl = rows[i].querySelector('b');
        const who = nameEl ? nameEl.textContent.trim() : '';
        const text = rows[i].textContent.replace(/\\s+/g, ' ');
        if (who === 'PeerHost') hostRow = text;
        if (who === 'PeerGuest') guestRow = text;
      }
      const joinable = Teams.joinablePeers().map(function (r) { return r.rec.name; });
      delete Net.peers['peerhost'];
      delete Net.peers['peerguest'];
      return { bar: barMine, hostRow: hostRow, guestRow: guestRow, joinable: joinable.join(',') };
    })();
    /* ---------- an address that does not answer ----------
       Three things can name a relay and they can disagree: the link a friend sent
       (?relay= on the URL), the address this deploy was built with
       (CONFIG.DEFAULT_RELAY), and the one this device dialled last (Profile). One
       of them going away - a tunnel that expired, a LAN address from another
       house, a playground that was replaced, which is what a deno.net host does
       when the app is renamed - reads as "the second machine cannot connect"
       while the game keeps reaching for the dead one on every load. So every
       address the device knows is walked in turn, best first, and each is tried
       once per session: it cannot become a loop, and when none is left the panel
       says where to find the new address. */
    out.addresses = (function () {
      const wasLink = Net.linkRelay, wasSaved = Net.savedRelay, wasDead = Net.dead;
      const wasBaked = CONFIG.DEFAULT_RELAY;
      const realDial = Net.dial;
      const dialled = [];
      Net.dial = function (target) {
        dialled.push(target);
        Net.lastWire = target;
        Net.relay = target;
        return true;
      };
      Net.linkRelay = 'wss://from-the-link.example/isle';
      Net.savedRelay = 'ws://gone.invalid:9/isle';
      CONFIG.DEFAULT_RELAY = 'wss://the-built-in.example/isle';
      Net.dead = null;
      const order = Net.addresses();
      const first = Net.tryNextAddress('ws://gone.invalid:9/isle');            // dials the link
      const second = Net.tryNextAddress('wss://from-the-link.example/isle');   // dials the built-in
      const third = Net.tryNextAddress('wss://the-built-in.example/isle');     // none left
      const why = Net.lastError;
      Net.dial = realDial;
      Net.linkRelay = wasLink;
      Net.savedRelay = wasSaved;
      Net.dead = wasDead;
      CONFIG.DEFAULT_RELAY = wasBaked;
      Net.relay = '';
      Net.lastWire = '';
      return { order: order.join(' '), dialled: dialled.join(' '),
               first: first, second: second, third: third, why: why };
    })();
    return out;
  })()`);
  console.log('  friends ui: ' + JSON.stringify(ui));
  check('the party bar shows the formats, the squad and the link state',
    ui.chips === 5 && ui.slots === 2 && /OFFLINE|PEER/.test(ui.net),
    ui.chips + ' chips, ' + ui.slots + ' slots, "' + ui.net + '"');
  check('FRIENDS opens its own screen', ui.screenOpen === true && ui.menuHidden === true);
  check('a friend can be added through the form', ui.added === true && ui.rows === 2,
    ui.rows + ' rows');
  check('INVITE puts the friend in the squad',
    ui.inParty === true && /Buddy/.test(ui.partyBar), ui.partyBar);
  check('the 1 v 1 button sets the format up against that friend',
    ui.mode === 'duel' && ui.rival === 'Buddy' && /1 V 1/.test(ui.duelLabel) &&
    /1 V 1/.test(ui.playLabel),
    ui.mode + ' vs ' + ui.rival + ' / "' + ui.playLabel + '"');
  check('BACK returns to the shelf', ui.backOnMenu === true && ui.friendsClosed === true);
  check('a request made with no lobby behind the page is kept, and reported as not sent',
    ui.kind === 'off' && ui.askedAgain.ok === true && ui.askedAgain.sent === false,
    JSON.stringify(ui.askedAgain) + ' while ' + ui.kind);
  check('and the header says the waiting request has not left this machine',
    /NOT SENT/.test(String(ui.sub)), ui.sub);
  check('the game names the fix rather than leaving a request that went nowhere',
    /PLAY-TOGETHER|CONNECT RELAY/.test(String(ui.why)), String(ui.why).slice(0, 84) + '...');
  check('a message typed while the socket is still opening is held, not claimed as sent',
    ui.held.said === false && ui.held.waiting === 1 && ui.held.sent === 1 && ui.held.left === 0,
    JSON.stringify(ui.held));
  check('the invite link is in the game, in a box that selects itself to be copied',
    !!ui.linkBox && ui.linkBox.readonly === true && ui.linkBox.value === ui.linkBox.wanted &&
    ui.linkBox.selected === ui.linkBox.value.length,
    JSON.stringify(ui.linkBox));
  let copyReport = null;
  for (let i = 0; i < 24 && !copyReport; i++) {
    copyReport = await evaluate('window.__copyReport || null');
    if (!copyReport) await sleep(125);
  }
  check('a copy the browser refuses is reported as blocked, not as copied',
    ui.copy.stubbed === true && copyReport === 'blocked',
    'stubbed ' + ui.copy.stubbed + ', reported ' + copyReport + ', ' + ui.copy.returned);
  check('the game knows whether it is hosting the party itself, or somebody else is',
    ui.hostName.solo === '' && ui.hostName.alone === 'Recruit' && ui.hostName.guest === 'Moe',
    JSON.stringify(ui.hostName));
  check('the party bar says who is hosting',
    ui.hostUi.bar.text === 'HOST: YOU' && /you/.test(ui.hostUi.bar.cls),
    JSON.stringify(ui.hostUi.bar));
  check('a host row is marked HOST, a guest row is marked GUEST and names the host',
    /HOST/.test(ui.hostUi.hostRow) && /GUEST/.test(ui.hostUi.guestRow) &&
    /in PeerHost's party/.test(ui.hostUi.guestRow), JSON.stringify(ui.hostUi));
  check('and a guest is not offered as a second door to the same party',
    ui.hostUi.joinable === 'PeerHost', String(ui.hostUi.joinable));
  check('every lobby address this device knows is tried in turn, and a dead one is not retried',
    ui.addresses.order === 'wss://from-the-link.example/isle wss://the-built-in.example/isle ' +
      'ws://gone.invalid:9/isle' &&
    ui.addresses.first === true && ui.addresses.second === true && ui.addresses.third === false &&
    ui.addresses.dialled === 'wss://from-the-link.example/isle wss://the-built-in.example/isle' &&
    /no other lobby address is known/.test(String(ui.addresses.why)) &&
    /console\.deno\.com/.test(String(ui.addresses.why)),
    JSON.stringify(ui.addresses));
  return { friends, party, duos, win, duel, back, ui };
};

