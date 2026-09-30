# Feature Prompt — Player Skins + Crouch Animations (index.html)

You are working on a single-file browser battle-royale game at
`C:\Users\Conner\Downloads\22\index.html` (vanilla JS + Three.js, everything inline,
no build step). The code is organized into modules: `World`, `Loot`, `Bots`, `Player`,
`Input`, `CAM`, `Hit`, `FX`, `SFX`, `UI`, `Game`, `App`, plus the character stack
`Character` (model loader), `CharacterRig` (procedural hinge rig), `PlayerView`
(poses the player) and `BotView` (instanced capsule bots). Keep the existing code
style (explanatory comments above non-obvious logic, `const` modules, helper reuse).
Do not add libraries or a build step. The page must keep working when opened
straight off the disk (`file://`), which is why binary assets ship as base64
`<script src>` sidecars.

Add two features. Do not change anything else.

---

## Feature 1 — Player skins (4 new character models)

**Goal:** The player can pick their character on the menu. The default stays Freddy;
four new skins join it. The models sit next to `index.html` already:

| file | skin | contents (probed) |
| --- | --- | --- |
| `freddy_fazzbear.glb` | Freddy Fazbear (existing default) | 6 meshes, **no skin** — static pieces |
| `bonnie.glb` | Bonnie | 7 meshes, **no skin** — static pieces, same shape as Freddy |
| `michael_gta_5_read_rules.glb` | Michael | 8 meshes, **no skin** — static pieces |
| `demi_-fortnite.glb` | Demi | 4 meshes, **1 skin**, 139 nodes — **skinned** |
| `fortnite_aura.glb` | Aura | 4 meshes, **1 skin**, 211 nodes, 1 embedded clip — **skinned** |

(Note the real filename is `demi_-fortnite.glb` with a dash.)

**Where to look:**
- `CONFIG.CHARACTER` (~line 1233): single-model config — `name`, `credit`,
  `enabled`, `file`, `base64File`, `base64Global`, `height`, `yawTurn`, `bob`,
  `sway`, `turnLead`, and the shared `anims` block (~1251–1270).
- `Character` module (~line 6758): `loadBytes()` (~6802) fetches the `.glb` over
  http(s) and falls back to the base64 sidecar over `file://`; the model is
  normalised (scaled to `height`, centred on X/Z, soles on y = 0, facing +Z).
  `anims` / `loadAnims()` (~6773, ~6863) load the `freddy_anims.js` sidecar.
- `PlayerView` `attachCharacter` (~line 7575): adds the model, builds the rig with
  `CharacterRig.build(model, CONFIG.CHARACTER.height)` (~7584), drops the rig when
  it finds fewer than 8 pieces (~7590), hides the primitive fallback body.
- `CharacterRig` (~line 7018): cuts a **static** model into its rigid pieces and
  hangs them on 14 hinges (hips, knees, feet, torso, neck, shoulders, elbows,
  hands). It cannot consume a `SkinnedMesh` skeleton as-is.
- `SETTINGS` (~line 1302) and the persisted profile store (~lines 9199/9209,
  `localStorage`) — the skin choice must persist the same way.
- Menu markup: the mode shelf / `modePick` block (~lines 808–814) and the settings
  panel behind `btnSettings` (~line 9976) are the two sensible homes for a picker.
- `tools/glb-to-b64.ps1`: packs a `.glb` into a base64 sidecar
  (`-Glb bonnie.glb -Global BONNIE_GLB_B64 -Out bonnie.glb.js`). One run per skin.
  Do NOT add the new sidecars as `<script>` tags in the page head — inject them on
  demand exactly like `loadSidecar()` does, so only the selected skin's megabytes
  are ever pulled in (`fortnite_aura.glb` alone becomes a ~19 MB sidecar).

**Requirements:**
- Replace the single-model config with a skin list, e.g. `CONFIG.SKINS`:
  `{ id, name, credit, file, base64File, base64Global, height, yawTurn }` per skin.
  Keep `CONFIG.CHARACTER.anims` (shared — every skin runs on the same 14-hinge rig
  and the same baked cycles). `height` defaults to 1.74 but is per skin; `yawTurn`
  is per skin (`Math.PI` if a model faces -Z after normalisation).
- `SETTINGS.skin` (skin id, default `'freddy'`), persisted like the other settings.
  A skin switch must not require a page reload: unload the old model (dispose
  geometries/textures), load the new one through the same `Character` pipeline,
  re-rig it, and re-attach the clips. Re-reading the setting at match start (the
  way `SETTINGS.touch` is handled) is the acceptable minimum.
- Menu picker: a row of skin chips (name under each) on the menu — mark the active
  one, show the skin's `credit` line, and show a load state per skin. A skin whose
  file is missing or fails to load/rig shows as unavailable and can never leave
  the player invisible: the primitive humanoid stays the fallback.
- **The two model classes.** Bonnie and Michael are static multi-piece models like
  Freddy — they should rig through `CharacterRig.build` unchanged (verify the
  piece count; `rig.pieces < 8` means the cut found nothing to hang on). Demi and
  Aura are **skinned**: the piece-cutter will not produce a sensible rig from a
  `SkinnedMesh`. For these, drive their own skeleton instead: detect
  `SkinnedMesh`/`Skeleton` at load, map the model's bones onto the rig's 14 hinge
  names (hips/spine/head/shoulders/elbows/hands/knees/feet — match by name, with a
  per-skin bone map in the config when the names differ), and feed them the same
  hinge rotations the baked clips and procedural poses produce, so **all** skins
  play the identical walk/run/crouch cycles. Normalisation still applies: scale to
  `height`, soles on y = 0, facing +Z. If a skinned model cannot be mapped, fall
  back with a `console.warn` and mark the skin unavailable — never ship a T-posing
  or invisible player.
- Bots are untouched: they stay instanced capsules in `BotView`.
- Keep `Character.report()` (the start-screen credit/load line) truthful per skin.

---

## Feature 2 — Crouch Idle + Crouch Walking animations

**Goal:** Crouching stops reusing the squashed standing cycle and plays the two new
Mixamo clips: `Crouch Idle.fbx` (standing still, crouched) and `Crouch Walking.fbx`
(moving, crouched). Both files sit in the project root — note the **spaces** in the
filenames.

**Where to look:**
- `tools/fbx-bake.js`: `CLIPS` list (~line 372) — add
  `{ id: 'crouchIdle', file: 'Crouch Idle.fbx' }` and
  `{ id: 'crouchWalk', file: 'Crouch Walking.fbx' }`. The retarget matches bones by
  their `mixamorig:` names (`MAP` in the tool), so run `node tools/fbx-bake.js
  --report` first: if the new clips use different bone names, extend `MAP` — do not
  guess. Rebuild with `node tools/fbx-bake.js`; the sidecar `freddy_anims.js`
  (`window.FREDDY_ANIMS`) gains `clips.crouchIdle` and `clips.crouchWalk`. Extend
  `tools/fbx-check.js` so the offline pass covers the two new clips too.
- `CharacterRig.setClips` (~line 7048): the vetting at ~7053 requires `walk` and
  `run`; keep those required and accept `crouchIdle`/`crouchWalk` as **optional** —
  an old sidecar without them must still validate and run.
- `advanceLoco` (~line 7321): today a crouch just squashes the standing cycle
  (`want *= A.crouch`, ~7328). Replace that with a real blend: add a
  `loco.crouch` weight (eased like `loco.run`), and when the crouch clips exist,
  crouching cross-fades the body from walk/run to `crouchIdle` (at rest) /
  `crouchWalk` (moving) instead. One normalised phase keeps driving every cycle so
  a walk-to-crouch-walk transition never lands the strides out of step. Keep the
  airborne/glide rule (`want = 0` while airborne) and the cadence clamps — crouch
  speed is `SPEED_CROUCH` 2.8 m/s (~line 1126), so add per-clip cadence tuning to
  `CONFIG.CHARACTER.anims` (e.g. `crouchStride`) rather than reusing `stride`.
- `sampleBoth` (~7078) / `applyClip` (~7347): extend the walk/run blend to include
  the crouch pair (`crouchIdle` mixed with `crouchWalk` by crouch speed, that pair
  cross-faded against walk/run by `loco.crouch`). The arm rule is unchanged: arms
  hand back to the procedural aim pose while a gun is held (`CLIP_ARMS`,
  `o.armed`). The bounce (`loco.bob`, ~7335) reads the crouch walk`s `bob` while
  crouched.
- `CONFIG.CHARACTER.anims.crouch` (0.25, ~line 1269) stays as the **fallback**
  squash factor for when the crouch clips are absent (old or missing sidecar).
- Gameplay is untouched: `Player.crouching`, `SPEED_CROUCH`, `CAM_PIVOT_CROUCH`
  (~1219), the `C / Ctrl` binding and the touch CROUCH button already exist — this
  feature is visuals only.
- Update the generated-sidecar header in `tools/fbx-bake.js` (~line 392) and
  `ANIMATION.md` — both still say walk and run only.

**Scenario updates:**
- `scenarios/fbxanim.js`: assert the two new clips load, have sane track shapes and
  knee fold; assert the walk-to-crouch cross-fade (no snap, shared phase), the
  crouch-walk cadence at 2.8 m/s, the armed arm hand-off while crouched, and the
  fallback path with a walk/run-only sidecar.
- `scenarios/charactermodel.js`: the existing crouching-folds-the-knees check
  (knee > 0.6, ~line 137) must keep passing — now driven by the clip.

---

## Validation (required before you finish)

1. `node syntax-check.js` passes — the file is one big inline script, so a typo
   kills the whole game.
2. `node tools/fbx-bake.js --report`, then `node tools/fbx-bake.js`, then
   `node tools/fbx-check.js` — all four clips bake and pass the offline checks.
3. Run the headless harness: `node cdp-test.js <scenario>` with at least
   `fbxanim`, `charactermodel`, `playtest`, `menu`, `thirdperson` and `fullmatch`,
   plus a new `scenarios/skins.js` that cycles every skin (each reaches
   `Character` state `ready`, gets rigged or skeleton-driven, normalises to the
   right height, shows on the player, persists the choice across a reload, and a
   missing file falls back to the humanoid). No console errors, no uncaught
   exceptions.
4. Summarize per feature: root design chosen (especially how the skinned models are
   driven), files/lines changed, the bake report, and the scenario output that
   proves it.
