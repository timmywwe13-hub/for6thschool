# Playing ISLE ROYALE on a phone (touch controls)

The desktop game is unchanged: mouse look, pointer lock, `WASD` and every action
key behave exactly as before. On a touch device an extra layer fades in over the
HUD - a floating movement stick, a look drag and a set of thumb-sized buttons -
and it drives **the same state** the keyboard drives, so nothing about the game
itself had to be re-written.

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │ [SWAP][BAND][SHIELD]          ▲ compass            [SCORES][MAP][PAUSE]│
   │ [SPRINT][MED][NADE]        zone timer                 ┌──────────┐    │
   │                                    kill feed          │ minimap  │    │
   │                                                       └──────────┘    │
   │                                          [PICK UP]                     │
   │                             {········}   [AIM]   [RELOAD]              │
   │        ▓▓▓┼▓▓▓              {  stick  }      [CROUCH]                  │
   │        hp / shield          {········}          [JUMP]  ( FIRE )       │
   └──────────────────────────────────────────────────────────────────────┘
```

## The two gestures

| gesture | what it does |
| --- | --- |
| Thumb down anywhere on the **left 45%** of the screen | Takes the movement stick. It is a *floating* stick: the base is drawn where your thumb landed (a faint ring idles in the bottom-left corner so you know where the zone is), so it fits any screen and a thumb never has to hunt for it. Full travel is 52 px; there is a 16% dead zone so a resting thumb never drifts. |
| Thumb drag anywhere **else** | Look. Dragging right turns right and dragging up looks up - the same sign convention as the mouse, because it goes through the same `Input.applyLook()`. The look speed is `SETTINGS.sensitivity × 2.6 × SETTINGS.touchSens`. |

A finger that slides off a button keeps it held (pointer capture) until it is
really lifted, and the stick and the look drag are independent, so you can walk,
aim and shoot at the same time.

## The buttons

| button | key it stands for |
| --- | --- |
| **FIRE** | left mouse: fires on the pull, and holding it keeps automatics going |
| **AIM** | `RMB` / `V` - tap to toggle the sights (a thumb cannot hold a button and aim) |
| **RELOAD** | `R` |
| **JUMP** | `Space` - also deploys the glider during the drop |
| **CROUCH** | `C` - tap to toggle |
| **SPRINT** | `Shift` - tap to toggle; it still needs the stick pushed forward, and the stamina rules still apply |
| **PICK UP** | `E` - lights up gold when something is in reach |
| **SWAP** | the mouse wheel |
| **BAND / MED / SHIELD / NADE** | `6` / `7` / `8` / `G`, with the count printed on the chip (dimmed when empty). Tap the same chip again to stop a heal. |
| **MAP / SCORES / PAUSE** | `M` / `Tab` / `Esc`. The fullscreen map is closed by tapping it |
| the 5 **weapon chips** | `1`…`5` - they stay visible and become tappable in touch mode |

Where the information used to be: the health bars and the weapon readout move to
the bottom centre (between the two thumbs), the minimap shrinks into the top
right corner, and the kill feed re-anchors under the zone panel. The consumable
row is hidden because the counts live on the buttons that cast them.

## How it decides to appear

`SETTINGS.touch` (`Settings → Touch controls`) has three values:

- **auto** (default) - on for a device whose primary pointer is coarse *and*
  cannot hover (`navigator.maxTouchPoints > 0` + `(hover: none)` +
  `(pointer: coarse)`). A touchscreen laptop has a hovering mouse, so it keeps
  the desktop controls.
- **on** - always, which is also how you try it out on a desktop.
- **off** - never.

The setting is re-read at the start of every match, so a tablet that gets docked
or a phone that gets picked up is handled without a reload.

Switching the layer on for the first time also steps the quality preset down
from *High* (100 bots, 2× pixels) to *Medium*, because the high preset does not
run on a phone; the announce line in the HUD says so. Pick a quality yourself
and it is left alone.

## Rules the layer keeps

- **No pointer lock.** `Input.requestLock()` is a no-op while the pad is on, and
  the pointer-lock handler ignores "lock lost" events, so the game never drops
  into the pause screen because a phone cannot capture a mouse.
- **Never stuck.** Pause, death, spectating, `blur`, a hidden tab, opening the
  map or the scoreboard all call `TouchUI.releaseAll()`, which drops the
  trigger, both toggles, the stick and every held button.
- **Key prompts are re-worded** while the pad is on: `WASD STEER` becomes
  `STICK STEERS`, `M / ESC — CLOSE MAP` becomes `TAP — CLOSE MAP`, the pickup
  prompt's `E` becomes `TAP`.
- **The pad hides behind menus**, and in portrait a "rotate the device" notice
  covers the play field - tapping it dismisses it, so nobody is ever locked out.
- **The desktop path is untouched**: with the setting off, nothing is registered
  differently and `scenarios/ads.js` (mouse/trackpad aiming) still passes.

## Testing it

```powershell
node cdp-test.js touch      # 46 checks: stick, look drag, every button, the
                            # settings rows, hit-testing and the cleanup rules
node cdp-test.js _touchshot # photographs the phone layout into playtest/
                            # (_touch-01-pad … _touch-05-portrait)
```

`scenarios/touch.js` builds real `TouchEvent`s on the canvas and real
`PointerEvent`s on the buttons, so it exercises the same handlers a finger does.
It also asserts that nothing covers a button (`document.elementFromPoint`) and
that a bare diagonal push is capped at unit length.
