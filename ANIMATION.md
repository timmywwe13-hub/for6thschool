# The player's walk, run and crouch (Mixamo FBX → the rig)

Freddy ships as one static mesh: no skeleton, no animation clips. The game has
always posed him with a procedural hinge rig (`CharacterRig` in `index.html`,
which cuts the mesh into its original rigid pieces and hangs them on hips,
knees, shoulders, elbows and a neck). That rig still runs the idle, the glide
and the armed pose - but the actual **gait now comes from real animation**,
crouched as well as upright, empty-handed as well as carrying a gun: the Mixamo
FBX clips in the project root.

```
walking.fbx              ─┐
Fast Run.fbx              │
Crouch Idle.fbx           ┤   tools/fbx-bake.js   ──►   freddy_anims.js   ──►   the page
Crouch Walking.fbx        │   (retarget, no deps)        (generated sidecar)      loads it
walking_armed.fbx        ─┘
```

## What ships

| file | role |
| --- | --- |
| `walking.fbx`, `Fast Run.fbx` | the upright source clips (Mixamo, 65-bone mocap skeleton, ~1.0 s / 0.53 s cycles) |
| `Crouch Idle.fbx`, `Crouch Walking.fbx` | the crouched source clips (~6.7 s idle sway, ~1.2 s stride) |
| `walking_armed.fbx` | the gun-in-hand walk (82 frames / 1.37 s, ~0.71 rad of hip swing): the armed stance, and the only source for the arm sway while a weapon is up |
| `tools/fbx-read.js` | minimal Kaydara binary FBX reader (no npm packages) |
| `tools/fbx-bake.js` | retargets the clips onto the rig's 14 hinges and writes the sidecar |
| `tools/fbx-check.js` | offline sanity pass over the generated tables (limb travel, knee direction, loop, feet on the floor) |
| `freddy_anims.js` | the generated sidecar - `window.FREDDY_ANIMS` (≈240 KB) |

`index.html` stays a single self-contained file: it never parses FBX. The
sidecar is a plain `<script src>` (the one load a `file://` page is always
allowed), and if it is missing the procedural cycle keeps the limbs moving -
the game never depends on it. The optional clips inside the sidecar are
optional for the same reason: an old sidecar with only walk/run still
validates, crouching falls back to the procedural knee fold, and carrying a gun
falls back to the aim pose owning the arms outright.

> Copying a `.fbx` through a text-oriented upload path re-encodes it as UTF-8
> and destroys it (the bytes above 0x7F become U+FFFD). Check the size and the
> replacement-character count before baking a clip that arrived that way
> (`playtest/walking_armed.corrupted-upload.fbx` is one such casualty, kept as
> the example).

## Rebuilding it

```powershell
# look at what the FBX files contain (skeleton, channels, clip length)
node tools/fbx-bake.js --report

# retarget every clip in CLIPS and write freddy_anims.js
node tools/fbx-bake.js

# play the result back through the rig and check the limbs
node tools/fbx-check.js
```

Replace any of the `.fbx` files with any other Mixamo clip (export "FBX
Binary", "Without Skin", 30-60 fps) and re-run the commands - the bone names
are matched by their `mixamorig:` names, so a differently named rig needs `MAP`
in `tools/fbx-bake.js` updated. If an export pads its take with a frozen tail
of held-pose keys (the run clip is one of those: 0.53 s of run stretched across
a 3.33 s take), set `trimTail: true` on its `CLIPS` entry and the bake cuts the
clip where the motion actually stops, keeping one held frame so the loop still
closes exactly.

A clip of a *different* kind of locomotion is one line in `CLIPS` plus the
runtime switch that uses it: the gun-carry walk arrived exactly that way
(`{ id: 'walkArmed', file: 'walking_armed.fbx' }`), with `armedStride`,
`armedArm` and `armedPose` in `CONFIG.CHARACTER.anims` and the armed branch in
`applyClip`.

## How the retarget works

For every source bone the tool builds a world-space *delta* from the clip's own
reference pose:

```
D(bone, t) = Rworld(bone, t) · Rworld_rest(bone)⁻¹
```

and gives the matching hinge the local rotation that makes the target's world
rotation follow it:

```
Rworld_target = D(bone) · Rworld_target_rest
Rlocal_target = Rworld_target(parent)⁻¹ · Rworld_target
```

Because the target's own rest pose is the base of that product, Freddy's
proportions and hierarchy are never overwritten by Mixamo's - only the motion
is transferred. Two details matter and are both handled in the tool:

* **FBX Euler angles are extrinsic.** An FBX `RotationOrder` of 0 ("XYZ") is
  intrinsic `ZYX` in three.js (`EULER_ORDER` in `tools/fbx-bake.js`). Getting
  this wrong turns the whole skeleton inside out.
* **Rest poses that differ.** Mixamo's reference pose is a T-pose; Freddy's
  arms hang at his sides. A world-space delta taken from a T-pose would fold
  Freddy's arms into his chest, so for the arm chain `MAP[bone].neutral`
  switches the reference from the source's rest orientation to the clip's
  **average world orientation**: what transfers is the swing around the middle
  of the clip, riding on the pose the model was actually built in. The legs,
  spine and head share the source's reference stance, so they keep their
  clip's absolute pose (`neutral: 0`).

The hips' vertical lift is baked alongside the joint angles (`bob`, in metres,
scaled by hip height), which is what gives the walk its bounce.

`freddy_anims.js` is Euler XYZ in radians, one key per frame at 60 Hz, per
hinge - the page just interpolates between frames at `loco.phase`.

## How the game uses it

`CONFIG.CHARACTER.anims` is the whole tuning surface:

| key | meaning |
| --- | --- |
| `enabled` | false = never load the sidecar, keep the procedural cycle |
| `file`, `global` | the sidecar and the global it defines |
| `stride` | metres of travel per stride cycle - the cadence follows the player's real speed |
| `rateMin`, `rateMax` | cadence clamp (cycles/second), so a creep or a sprint never looks sped-up |
| `blend` | the speed at which the cycle has fully taken the limbs over |
| `runFrom`, `runFull` | the speed window where the run cycle cross-fades in |
| `crouchStride` | metres per stride for the baked crouch walk |
| `crouch` | how much of the upright cycle survives a crouch (fallback only - used when the sidecar has no crouch pair) |
| `armedStride` | metres per stride for the gun-carry walk - a shorter, quicker armed step |
| `armedArm` | share of the gun-carry clip's **arm swing** taken on top of the aim hold (0.6) |
| `armedPose` | share of its **carry posture** (spine and head) taken on top of the aim hold (0.35) |

Notes on the behaviour:

* One normalised phase drives every cycle, so a walk-to-run cross-fade never
  lands the two strides out of step.
* The cycle owns the spine, head and legs whenever the player is moving. The
  **arms** hand back to the procedural pose while he is holding a gun (the
  aiming pose is what the gun in front of his chest is built around - unless the
  sidecar has the gun-carry walk, see the next note) and the whole body hands
  back while he is gliding.
* Carrying a gun swaps in the gun-carry walk for the legs, hips and bounce
  (whole), and takes its arms and carry posture at `armedArm` / `armedPose`
  only. The clip blades the chest about 0.56 rad at the weapon and pitches the
  head 0.47 rad down - a proper two-handed carry, but the gun hangs off the aim
  pose on its chest mount and cannot follow a bladed torso, so taking the blade
  whole walks the paws off the weapon. At the shipped shares the right hand sits
  on the receiver through the cycle
  (`scenarios/_armedshot.js` measures it; `playtest/armed-walk-*.png` shows it).
* Crouching swaps in the baked crouch idle/walk pair. The rig's hinges cannot
  translate, so a hip-dropped crouch pose would lift the feet - the bake
  measures how far (`sink`, per clip) and the runtime folds it into the model's
  bob, so the feet stay planted and `PlayerView` needs no special case. The old
  procedural crouch fold and the `PlayerView` squash both fade out exactly as
  the clip pair takes over, so nothing double-folds.
* `PlayerView.loco()` exposes the live state (phase, clip weight, walk/run mix,
  crouch blend, bounce) for debugging and for the scenario harness.

## Verifying

```powershell
node cdp-test.js fbxanim        # the clips load, drive the limbs, hand over correctly
node cdp-test.js charactermodel # the rig itself: 14 hinges, swing, crouch, glide
node tools/fbx-check.js         # offline: limb travel, knee direction, foot height
node cdp-test.js _armedshot     # photos of the gun carry -> playtest/armed-walk-*.png
node cdp-test.js _armprobe      # what moves the hands while armed (a scratch probe)
```

`scenarios/fbxanim.js` covers the data (cycle lengths, track shapes, hip/knee
swing, bounce), the speed-driven behaviour (cadence, walk→run cross-fade), the
hand-overs (glide, armed - including how much of the carry posture is taken, and
the old-sidecar fallback) and the fallback path with no sidecar at all.

The two `_`-prefixed probes are diagnostics rather than checks: `_armedshot`
poses the rig by hand at three points of the gun-carry cycle with a frozen sim,
photographs it from the front and logs the hand and gun positions, then repeats
with the gun-carry clip taken back out of the rig so the two looks can be
compared; `_armprobe` sweeps a scale over the clip's arm and torso tracks and
reports where the right hand lands, which is how the `armedArm` / `armedPose`
shares were picked.
