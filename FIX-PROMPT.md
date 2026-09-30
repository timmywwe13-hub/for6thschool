# Bug-Fix Prompt — Battle Royale Game (index.html)

You are working on a single-file browser battle-royale game at
`C:\Users\Conner\Downloads\22\index.html` (vanilla JS + Three.js, everything inline,
no build step). The code is organized into modules: `World`, `Loot`, `Bots`, `Player`,
`Input`, `CAM`, `Hit`, `FX`, `SFX`, `UI`, `Game`, `App`. Keep the existing code style
(explanatory comments above non-obvious logic, `const` modules, helper reuse).

Fix these three bugs. Do not change anything else. Do not add libraries or a build step.

---

## Bug 1 — Bots spawn holding guns instead of finding them

**Symptom:** When a match starts, bots already have weapons ("guns off the bat").
They should land empty-handed and loot weapons from the world exactly like the player.

**Where to look:**
- `makeBot()` (~line 2935): the bot template hardcodes `weaponId: 'pistol'` with
  zeroed ammo. Even though `Bots.reset()` (~line 2980–2985) sets `weaponId = null`,
  audit every path that can re-arm a bot before it has actually looted a weapon:
  `Bots.reset`, `upgradeGear` / loot pickup logic, `downgradeWeapon` (~line 3378),
  and any place that writes `b.weaponId`, `b.weapons`, `b.mag`, or `b.ammoReserve`.
- `Bots.fireAt()` (~line 3318): confirm an unarmed bot can never fire
  (`if (!w) return` must hold from frame one).

**Fix requirements:**
- Every bot spawns with `weaponId = null`, `weapons = []`, `mag = 0`, and an empty
  `ammoReserve`. Change the template default so `null` is the natural starting value,
  not something that has to be patched up after `makeBot()`.
- Bots may ONLY obtain a gun by walking to a loot point and picking it up through the
  same loot pipeline the world items use — no free starting pistol, no silent arming
  during the drop/parachute phase.
- Verify with the existing scenario harness (`scenarios/botgear.js` via `cdp-test.js`):
  at match start, 100% of bots are unarmed; after they loot, they arm up normally.

---

## Bug 2 — Bots shoot through walls and houses

**Symptom:** Bots damage the player (and each other) through solid walls, houses,
and other cover. Tracers and damage pass through geometry.

**Where to look:**
- `Bots.fireAt()` (~line 3318): it applies hitscan damage DIRECTLY to `tgt` with
  `Hit.damage(...)` using only a probability roll — it never raycasts the actual
  shot line, so whatever `checkSight` decided up to ~0.5s ago (the `losT` cache,
  ~line 3157–3159) is treated as still true.
- `Bots.checkSight()` (~line 3171–3185): the late-game branch
  (`Zone.state === 'final' || Zone.cur.r < 45`) deliberately lets a bot keep engaging
  a target it CANNOT see at point-blank range (`dist <= 14`), which produces
  through-wall shots even outside the final circle if the target caches in.
- `World.losClear(ax,ay,az,bx,by,bz)` (~line 1896) and `World.raycast` (~line 1869)
  already exist — use them.

**Fix requirements:**
- At the moment of each shot in `fireAt`, run a fresh
  `World.losClear(muzzleX, muzzleY, muzzleZ, targetX, targetY, targetZ)` check
  (muzzle = the bot's eye/gun position already computed at ~line 3346–3348).
  If the line is blocked, the shot does NOT happen: no tracer, no sound, no damage,
  no ammo spent — the bot re-acquires or repositions instead.
- Remove or strictly narrow the "engage through cover" exception in `checkSight`:
  a bot may push toward a last-known position, but it must never deal damage without
  a clear line of sight. This applies in EVERY zone phase, including the final circle.
- Misses must also respect geometry: when a shot misses, the tracer should terminate
  at the first wall hit (`World.raycast`), not sail through houses.
- Verify with `scenarios/aiprobe.js` / `scenarios/collision.js`: place a wall/house
  between a bot and a target, confirm zero damage events and no tracer penetration.

---

## Bug 3 — Aim-down-sights (ADS) is broken on laptop trackpads

**Symptom:** ADS only works with a physical mouse right-click. On a laptop trackpad
(two-finger click / bottom-right corner press), ADS does not engage reliably —
especially while moving or aiming — making the game unplayable on laptops.

**Where to look:**
- `Input.onMouse()` (~line 5312): ADS is bound exclusively to
  `e.button === 2` via `mousedown`/`mouseup`. Trackpads often deliver right-clicks as
  `pointerdown`/`auxclick` (or not at all) while pointer lock is active, and
  click-while-moving gestures frequently get swallowed.
- `contextmenu` is already suppressed (~line 5224).
- ADS state flows through `Input.ads` → `Player.update` (speed `SPEED_ADS`,
  `CAM_DIST_ADS`, `FOV_ADS` ~lines 508, 563, 597).

**Fix requirements:**
- Listen to `pointerdown`/`pointerup` (with mouse fallback) and also handle
  `auxclick`, so trackpad right-clicks reliably toggle/hold ADS under pointer lock.
- Add a keyboard ADS alternative: hold **Left Shift** (or make the key configurable
  in `SETTINGS`) to aim, in addition to RMB. Update the help screen controls table
  (the `RMB — Aim down sights` row near line 350) to document both bindings.
- Add a `SETTINGS.adsToggle` option (persisted like the other settings): when ON,
  RMB/Shift toggles ADS instead of hold-to-aim — essential for trackpad users who
  can't hold a click and swipe at the same time.
- Releasing pointer lock, dying, or opening the map/scoreboard must force-clear
  the ADS state so the player never gets stuck zoomed in.

---

## Validation (required before you finish)

1. `node syntax-check.js` (or equivalent) passes — the file is one big inline script,
   so a typo kills the whole game.
2. Run the headless harness: `node cdp-test.js <scenario>` with at least
   `botgear`, `aiprobe`, `collision`, `weapons`, and `fullmatch`. No console errors,
   no uncaught exceptions.
3. Summarize per bug: root cause found, lines changed, and the scenario output that
   proves the fix.
