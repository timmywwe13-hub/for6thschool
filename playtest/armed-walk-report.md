# The gun-carry walk - what was done and how it was checked

*(the armed stroll behind `walking_armed.fbx`: the body carries the weapon
instead of standing the procedural aim pose on a walking pair of legs)*

## The clip

| | |
| --- | --- |
| source | `walking_armed.fbx` (480,864 bytes, sha256 `9BFF6DC575E243B2…`) |
| skeleton | 65-bone Mixamo, same rig and naming as the other four clips |
| clip | 82 frames @ 60 Hz = 1.367 s, 1.37 m of travel, 0.71 rad of hip swing |
| bake | one entry in `CLIPS` (`tools/fbx-bake.js`) - no special casing anywhere |
| sidecar | `freddy_anims.js`, 237 KB, rebuild is byte-identical (sha256 `35B370F31D64E072…`) |

The file arrived through the chat upload path and came back **corrupted**: the
binary FBX had been decoded as text and re-encoded, so every byte above 0x7F
had become the UTF-8 replacement character (72,792 of them, the first at offset
27). The intact original was still in `Downloads`; that copy is the one in the
project. The casualty is kept as evidence -
`playtest/walking_armed.corrupted-upload.fbx`.

## The pose problem, and the shares

`applyClip()` *adds* the cycle on top of whatever the rig is already doing, and
while a gun is up that is the procedural aim pose. That works for the legs,
hips and bounce - the clip's stride is taken whole - but not for the upper
body, because the clip is a *two-handed carry*: at its rearmost point the chest
is bladed **0.564 rad** off the walking direction and the head is pitched
**0.47 rad** down. The gun, though, hangs off the aim pose on its chest mount -
and the muzzle the flash is fired from follows the gun - so it cannot follow a
bladed torso: taking the posture whole walks the paws off the weapon.

So the armed branch takes the clip's arms at `armedArm` and its posture at
`armedPose`, both as shares of the track rather than the track itself:

```js
armedStride: 3.6,   // metres per gun-carry cycle: the armed walk is a shorter step
armedArm:    0.6,   // share of the gun-carry clip's arm swing while a gun is up
armedPose:   0.35,  // share of its carry posture (torso yaw + head pitch)
```

The arm share is still enough for the hands to pick up the clip's swing
(0.148 rad of shoulder travel on top of the hold) and the posture share leaves
the gun where the aim pose put it - with the clip's own bladed carry readable
as a hint (0.193 rad of the 0.564, head pitch 0.172 rad). Whole-body
fallbacks are untouched: no sidecar, no clip, or an old sidecar without the
gun-carry walk all hand the arms back to the aim pose exactly as before.

## What it looks like

`playtest/armed-walk-*.png` and the same three phases with the gun-carry clip
**removed** from the rig (`aim-walk-*.png`) are the A/B, shot by
`node cdp-test.js _armedshot` with a frozen sim (so the two runs differ only in
the clip):

| frame | phase | armed | ankle L/R | feet apart | right hand |
| --- | --- | --- | --- | --- | --- |
| `armed-walk-0` | 0.00 | 0.70 | 0.224 / 0.184 | 0.34 m | (0.352, 1.122, 0.465) |
| `armed-walk-1` | 0.33 | 0.91 | 0.175 / 0.245 | 0.24 m | (0.285, 1.088, 0.448) |
| `armed-walk-2` | 0.66 | 0.97 | 0.197 / 0.222 | 0.45 m | (0.286, 1.124, 0.460) |
| `aim-walk-1` (clip dropped) | 0.33 | 0.09 | 0.184 / 0.247 | 0.50 m | (0.374, 1.117, 0.504) |

(`feet apart` is the horizontal distance between the two ankles, `armed` the
weight of the gun-carry cycle in `PlayerView.loco()`.)

Read: the armed frames stride - the ankles swap which one is lifted, 0.24 m
apart at the passing position and 0.45 m at full stride - and both paws sit on
the weapon: with the gun's own origin logged at (0.24, 0.98, 0.42), the right
hand is on the receiver within 4-5 cm in x and z through the middle of the
cycle, and 5.6 cm *closer* to it in z than the aim-pose-only frame. The head is
carried a touch lower and the chest a hint bladed; the feet never leave the
floor band (0.17-0.25 m at the ankle). Dropping the clip leaves the same walk
with the aim stance back upright and the hands pulled off the weapon - which is
exactly the bug this replaces.

## Checks

Offline (`node tools/fbx-bake.js` then `node tools/fbx-check.js`): all five
clips bake and pass - limb travel, hands clear of the body, knees folding
backwards only, feet between the floor and a raised stride, bounce not a pogo,
and every cycle closing on its first frame (worst joint gap 0.060 rad, the
gun-carry walk itself 0.056).

In the browser:

| scenario | result |
| --- | --- |
| `fbxanim` | **22/22** - incl. *carrying a gun hands the body to the gun-carry cycle*, *the arms keep the aim hold and pick up the carry cycle's own swing*, *the carry posture is taken at a share, so the gun stays in his hands*, *an older sidecar (no gun-carry walk) still hands the arms back while armed* |
| `charactermodel` | 17/17 |
| `thirdperson`, `ads`, `weapons` | 27/27, 16/16, 25/25 |
| `playtest`, `botfight`, `collision`, `wallshot` | 16/16, 4/4, 13/13, 10/10 |
| `skins`, `items`, `hud`, `aimprobe` | 43/43, 19/19, 45/45, 1/1 |
| `headprobe`, `hitprobe`, `hitprobe2`, `systems` | 1/1, 3/3, 3/3, 18/18 |
| `boot`, `menu`, `chests`, `surffloor` | 29/29, 25/25, 10/10, 6/6 |

`rigprobe` ran as a probe (no assertions) with a clean console. Full transcript:
`playtest/armed-walk-suite.log`. The five batches were driven detached with
`node tools/suite.js --lanes=2 <names>` because a foreground run of more than
one scenario per lane exceeds the shell's own timeout here.

## Reproduce

```powershell
node tools/fbx-bake.js --report      # what is in the FBX files
node tools/fbx-bake.js               # retarget all five clips -> freddy_anims.js
node tools/fbx-check.js              # offline limb/foot/loop sanity
node cdp-test.js fbxanim             # the data and the hand-overs, 22 checks
node cdp-test.js charactermodel      # the rig, 17 checks
node cdp-test.js _armedshot          # re-shoot armed-walk-*.png / aim-walk-*.png
```
