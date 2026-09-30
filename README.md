# ISLE ROYALE - a browser battle royale

A battle royale that runs in the browser, in one folder: no build step, no
bundler, no framework, no `npm install` for the game itself. `index.html` plus
the assets next to it *is* the game - three.js loads from a CDN, the character
models load as `.glb` (with a base64 sidecar for `file://` pages), and everything
else is inline.

```bash
node lobby-server.js        # the lobby: serves the game and relays the websockets
# open the printed link on every device - that is the whole setup
node cdp-test.js teams      # the validation harness (headless browser scenarios)
```

## What is in here

| | |
| --- | --- |
| `index.html` | the game: renderer, HUD, menus, match, and the client half of the lobby |
| `lobby-server.js` | the lobby: static hosting + a zero-dependency websocket relay with rooms |
| `PLAY-TOGETHER.cmd` | double-click to host on this machine: the lobby, for the same wifi |
| `PLAY-ONLINE.cmd` | double-click to host on the internet: lobby + a free tunnel, one link |
| `relay-deno.js` / `deno-relay.zip` | the same lobby for Deno Deploy - paste it in a browser, nothing left running |
| `tools/supa-fake.js`, `tools/supa-check.js` | the Supabase lobby: a Realtime server to test against, and one command to check a real project |
| `tools/web-build.js` | builds `web/`, the folder a host serves (drops the sidecars; bakes `ISLE_SUPABASE_URL` / `ISLE_SUPABASE_KEY` in when they are set) |
| `netlify.toml` | the whole deploy in one file: build `web/`, publish it, no cache on `index.html` |
| `.github/workflows/scenarios.yml` | the checks on every push, plus a build with the Supabase secrets so a deploy cannot come up offline |
| `HOW-TO-PLAY.txt` | the same instructions in plain text, for whoever gets the folder |
| `vendor/GLTFLoader.js` | three.js' glTF loader, built as a classic script |
| `*.glb` / `*.glb.js` | the character and island models, and their base64 sidecars |
| `scenarios/` | one file per system, driven by the harness - the project's test suite |
| `cdp-test.js`, `cdp-lib.js` | the harness: boots Edge/Chrome headless and runs a scenario |
| `tools/` | the bake/audit scripts that produced the generated assets |
| `playtest/` | recorded run output (logs, screenshots), not needed to play |

## Play with friends on other devices

The folder is self-contained: copied onto a stick or a hard disk, it plays with
no setup at all, and one person per session starts the lobby.

1. **One person** double-clicks `PLAY-TOGETHER.cmd` (Windows; anywhere else:
   `node lobby-server.js`). That is the host, and the only machine that needs
   [Node.js](https://nodejs.org/). Its browser opens the game; the window it keeps
   open prints the address to share, like `http://192.168.1.24:8787/?room=isle`.
2. **Everyone else** opens that address, or the **COPY INVITE LINK** the host
   sends (Discord, WhatsApp, anything). Opening a link is a one-press join: the
   game dials the lobby and lands in the room on load, with no typing.
3. Each device picks its own name (**Settings -> Player name**) and the game keeps
   it. Two players with the same name cannot see each other - and the relay now
   warns both of them, loudly, when it happens.
4. **ADD FRIEND** sends a real request: the other device gets a notification with
   **ACCEPT** and **DECLINE**, and answering it puts you on each other's list.
   Behind a link a friend only opened (a static host, with no lobby behind it)
   the game answers **ADDED - NOT SENT (NO LOBBY)** instead of claiming the
   request went: the name is kept, and the request leaves by itself as soon as
   there is a lobby - see *If ADD FRIEND "did nothing"* in `DEPLOY-ONLINE.md`.
5. **The party bar says who is hosting** - `HOST: YOU` when the party is yours to
   grow, `HOST: <name>` when you are in somebody else's - and the roster marks the
   owner's row **HOST** and a guest's row **GUEST**, because only the owner can
   take a player in: that is the row with the JOIN button on it.
6. **LOBBY** puts everybody who is online in a room you can look at: each player
   standing in the character they picked, in the skin they picked, with their name
   and what they are queuing for over their head. You walk a slow lap of it (no
   keys, no clicking), so you can see each other move. It needs no extra download -
   a skin you have already seen costs nothing - and a friend's model arrives while a
   plain stand-in holds their place. See §1c of `FRIENDS-NET.md`.

Whatever somebody sends you, FRIENDS has a box for it. A **Supabase project** -
the Project URL and the key - goes in the two **ONLINE** boxes at the top: that
machine keeps them, so it is the only time it asks. An invite link, the lobby's
own address, a host and port, or a `ws://…/isle` line goes in **ANOTHER LOBBY**
at the bottom. If you were handed the *folder* instead of a link, open
`index.html`; the game says exactly that when it notices it was opened as a file,
and names the box to use.


## Putting it online

No terminal is needed to get this on the internet, and the path this repository
uses is three services and one push (`DEPLOY-ONLINE.md` §1 walks through it):

1. **The lobby** - a free **Supabase** project. Its Realtime server is a lobby the
   game speaks directly: **New project**, then **Project settings -> API keys** for
   the two values (Project URL and publishable key). No SQL, no tables, nothing to
   switch on. `node tools/supa-check.js <url> <key>` checks a project before you
   trust it to a class.
2. **The code** - GitHub. `git init -b main`, `git add -A && git commit -m
   "Isle Royale"`, then push. Nothing secret goes with it.
3. **The game** - Netlify, imported from that repository. `netlify.toml` already
   says the build command (`node tools/web-build.js`) and the publish directory
   (`web`), so there is no form to fill in.
4. **The two values** - `ISLE_SUPABASE_URL` and `ISLE_SUPABASE_KEY` as environment
   variables on Netlify, which the build bakes into `web/index.html`. They are the
   only secret in the setup, and they are deliberately not in any file.
5. **Deploy** - once by hand, then every push does it, after the checks in
   `.github/workflows/scenarios.yml`. Those include a build with the two
   variables, so a push can never ship a page with no lobby in it.

What comes out is one link: the game loads and is already in the lobby, so a
Chromebook needs no address, no app and nothing typed (the FRIENDS panel reads
`ONLINE - LOBBY ISLE - SUPABASE`).

The same thing without a repository, all in a browser: build `web/` and drag it
onto <https://app.netlify.com/drop> (the build drops the `.glb.js` sidecars,
because drag-and-drop hosts stall on big files and over http the game fetches the
real `.glb`), or leave the project out of the build entirely and let each machine
enter it once in **FRIENDS -> ONLINE** - two fields, kept forever. Two more
alternatives: `deno-relay.zip` into a <https://console.deno.com> playground gives
an always-on `wss://` relay (Deploy Classic's `dash.deno.com` was shut down on
20 July 2026), and `PLAY-ONLINE.cmd` gives a link that lives as long as your PC
does. `DEPLOY-ONLINE.md` §4 and §5 cover the last two, plus the folder on a
stick.

## Validation

```bash
node cdp-test.js boot          # boots the game and reports console errors
node cdp-test.js teams         # formats, party, the friends screen (no transport)
node cdp-test.js friendreq     # requests, notifications, staying online
node cdp-test.js friendsnet    # two devices through the real relay
node cdp-test.js supanet       # two devices through a Supabase channel
node cdp-test.js online        # the plain link, the two fields, and the bake
node cdp-test.js lobby         # the lobby you can see: avatars, skins, live poses
node cdp-test.js netperf       # the relay under load
node tools/supa-check.js       # the Supabase protocol, on its own (offline fake)
```

The harness boots Edge/Chrome headless over the DevTools protocol, loads the real
`index.html`, and drives it the way a player would - clicking real buttons,
reading real DOM - then prints `PASS`/`FAIL` per check. It needs a browser and
nothing else (`BROWSER_PATH` overrides which one).

`.github/workflows/scenarios.yml` runs the lobby-facing subset above on every push
and pull request, on a Linux runner with Google Chrome, so none of it depends on
the machine it was written on.

## Docs, one per system

`FRIENDS-NET.md` (the social panel, the lobby protocol, requests, presence),
`LOOT-BUS-TEAMS.md` (loot, the bus, parties and formats), `ANIMATION.md` (the
character rig and its baked cycles), `TOUCH.md` (the touch controls),
`DEPLOY-ONLINE.md` (hosting it for real).

The rule the whole project follows: every system has a scenario that drives the
*shipped* code in a real browser (`node cdp-test.js <scenario>`), and the docs
describe what those scenarios actually assert rather than what was intended.
