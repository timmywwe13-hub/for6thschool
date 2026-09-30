# Chests, the Battle Bus, teams and the online layer

Everything here lives in `index.html` (vanilla JS + three.js, no build step) and
is validated with `node cdp-test.js <scenario>`.

| what | where | scenario |
| --- | --- | --- |
| Chests hold every gun | `Loot.initChests` / `populateChests` / `openChest` | `chests` |
| Bots: 100 hp, shields drunk the player's way | `Bots.startUse` / `pickUseKind` / `healBehaviour` | `botheal` |
| Nothing falls under the world | `World.floorFor` / `rescueFromVoid`, sliced movement | `_fallprobe` |
| The battle bus | `Bus` + the `BUS` branch of `Game.update` | `battlebus` |
| Friends, party, duos/trios/squads, 1v1 | `Friends` / `Net` / `Teams` | `teams` |
| Friends on other devices (the lobby server) | `lobby-server.js` + `Net` / `Teams` | `friendsnet` |

The social panel and the relay that carries a lobby between machines have their
own write-up: **[FRIENDS-NET.md](FRIENDS-NET.md)**.

## 1. Chests, and no guns on the floor

Guns used to lie on the open ground (a ~55% chance at each of ~420 loot points).
They are gone from it: `Loot.rollItem(luck, allowWeapon)` only produces a weapon
when the caller passes `allowWeapon`, and `populate()` never does. Every firearm
in a match now comes from one of three places:

* **a chest** - `Loot.populateChests()` hides `CONFIG.CHEST_COUNT` of them: the
  loot points inside the towns first, then **one per building**, which is where
  they live in the real thing and which is what keeps the early game armed at
  roughly the rate the old floor loot did. `freeSpot()` nudges each one onto
  ground a body can actually walk up to, because a chest sealed inside a room a
  bot cannot path into is a chest nobody ever opens. Every chest carries a gun:
  its first roll is *forced* to one (`CHEST_FIRST_IS_GUN: 1.0`), because
  `rollItem` only rolls a weapon 42% of the time even when it is allowed one and
  a chest that opens without a firearm is a wasted race - plus 1-3 more items, and
  opening one (`Loot.openChest`) drops them on the ground around it.
* **a body** - `Loot.dropFrom`, unchanged.
* **a supply drop** - the crate that parachutes in every other zone phase.

A chest is aimable exactly like a ground item: the crosshair picks whichever of
the two it is looking at more squarely, the prompt reads `E Open CHEST`, and
`Loot.take` routes to `openChest`. The chest is the model the project shipped in
`animated_old_chest.glb`, baked into `chest_model.js` by `tools/chest-bake.js`:
the skinned mesh cut into five rigid parts, each with its own sampled animation
track, so one instanced mesh per part carries the whole island and the lid opens
the way the artist animated it. The crosshair cracks that lid open as you look at
it and an emptied chest shuts again a moment later - see the chest section of
`LOOT`, `node cdp-test.js _chestshot`, and playtest/_chest-{closed,peek,open,shut}.png.

Bots keep the invariant that they can never be handed anything: `upgradeGear`
walks a bot to a chest, `openChestIfNear` cracks it (a reach of 4.6 m armed and
8.1 m unarmed), and the contents are ordinary ground items that
`tryPickupWeapon` - a 6 m reach - then takes. The same two-step the player goes
through.

### What that costs, and the knobs

Moving the guns off the floor slows the lobby down: the `botgear` scenario
measures ~35% of survivors armed at 30 s, ~60% at 90 s, and 65-80% by the time
the first circles close. The scenario thresholds were set against the old
floor-loot curve and were relaxed where the design changed on purpose, with the
reason written next to the assertion.

The knobs, in the order they matter: `CHEST_COUNT` (and `CHEST_MIN_SEP`, which
is what actually caps how many the loot points can hold), `CHEST_FIRST_IS_GUN`,
`CHEST_ALSO_GUN`, the bot loot FSM's "give up on an unreachable chest" timeout
(`stateT > 10` in `Bots.step`) and the two bot reaches above.


## 2. Bots have 100 health and drink shield like you do

`CONFIG.BOT_MAX_HP` is 100 and every bot spawns on it. Shield no longer appears
on a bot out of thin air: what it finds is the *potion*, and taking it is a state
the bot commits to.

`Bots.startUse(bot, kind)` mirrors `Player.startUse`: the item's real use time
(`MEDKIT_TIME` 6 s, `BANDAGE_TIME` 2.4 s, `SHIELD_TIME` 3.4 s), a reduced walk
speed while it is going on (the player's `speed *= 0.55`), and the health or
shield banked only when the timer completes. `Hit.damage` cancels it exactly like
`Player.cancelUse` - and the potion is *not* consumed, so a bot that keeps being
interrupted does not drain its own inventory.

Priority (`Bots.pickUseKind`): below `CONFIG.BOT_USE_SHIELD_AT` (40) health it
heals HP first; otherwise it tops shields up whenever there is room for a whole
dose; otherwise it bandages. While a bot carries shield you can see it - every
bot draws the same shell the player does (`BotView.bubble`).

## 3. Nobody falls under the world

The terrain query is a hard surface, so the interesting case is a walkable
*platform* (a pier deck, a bridge, the dam crest, a crate top). `World.groundAt`
only counts a platform within 0.62 m of the feet - the step-up window - so a frame
long enough to carry a body more than that in one go stepped straight past it and
left the player standing on the terrain *under* the deck, or in the water under a
bridge. `_fallprobe` reproduced exactly that on both maps (up to four platforms
per map at a 0.1 s frame, all of them ending at -0.35 m, i.e. in the sea).

Two changes close it:

* **sliced movement.** `Player.update`, `Player.updateDrop`, `Bots.integrate` and
  `Bots.dropStep` split a frame into steps no longer than `CONFIG.MAX_VERT_STEP`
  (0.42 m) and re-run the collision pass and the ground snap after each one, so
  no step can jump a platform.
* **a floor and a rescue.** `World.floorFor(x, z)` is the altitude a body may
  never sink below (the terrain, or the sea surface in deep water) and
  `World.rescueFromVoid(pos)` lifts a body back on top of it. The player's walk
  integrator and the bots' both call it, and `App.rescues` counts how often - it
  should stay zero, and the probe asserts that.

## 4. The battle bus

Every match opens on the bus, not in the air.

* `Bus.buildRoute()` lays a straight line across the island from well outside the
  coast, at a random bearing with a lateral offset, so the ride differs every
  match. The minimap draws the line and the bus on it.
* `Bus.start(scene)` puts the player in a seat (`Bus.seatFor`) and every bot on
  board. `App.state` becomes `'BUS'`, which `Game.update` handles with a short
  circuit: the zone does not tick (the storm starts when the first player lands),
  the bots do not run their AI, and `Bus.update` owns the camera, so the mouse
  looks around from the seat.
* **Space** (the touch JUMP button, or a click on a phone's pad) calls
  `Bus.jump()`: the player is placed at the bus's position with a shove along its
  heading, `Player.airborne` goes true and the existing skydive takes over - glide
  with Space again, steer with WASD. `App.state` becomes `'DROP'`.
* Bots ride with their own `busJumpAt` (a random moment inside
  `CONFIG.BUS_TICKET`), and `Bus.finish()` throws out anybody still aboard when
  the bus runs out of line or the ticket expires. A player who never presses
  anything is ejected and lands like everyone else.
* The HUD shows a bus panel: the line, how far along it is, the altitude and how
  many are still aboard.

