# Friends, and playing with friends on other devices

Two things live here: the social panel the reference screen is shaped like, and
the lobby server that makes "on another device" true rather than aspirational.

| what | where | validated by |
| --- | --- | --- |
| the friends panel (badge, tabs, sections, rows) | `Teams.paintFriends` / `friendRow` / `partyRow` | `friendsnet`, `teams`, `friendreq` |
| the relay server (HTTP + websocket + rooms) | `lobby-server.js` | `friendsnet`, `friendreq`, `netperf` |
| the Supabase transport (join, broadcast, presence) | `Net.connectSupabase` / `supaHandle` / `supaPush` | `supanet`, `supa-check` |
| a Realtime server to test that against | `tools/supa-fake.js` | `supanet`, `supa-check` |
| the lobby you can see (avatars, skins, name tags) | `Lobby` / `Avatar` / `Avatar.roster` | `lobby` |
| the live-pose stream (where everybody is) | `Net.poseOn` / `poseTick` / `poseOf` | `lobby` |
| presence, heartbeat, roster, staying online | `Net.announce` / `tick` / `handle` / `roster` / `wake` | `friendsnet`, `friendreq`, `supanet` |
| the address box: links, hosts, relay lines, projects | `Net.normalize` / `linkFromRelay` / `supaWire` | `friendreq`, `supanet` |
| the invite link itself, in a box that selects itself | `Net.copyText` / `Teams.paint` / `#inviteLink` | `teams`, `friendreq`, `supanet` |
| a request that cannot leave the machine saying so | `Net.send` / `hold` / `flush` / `whyOffline` | `teams` |
| what a pasted address is dialled as | `Net.wire` / `isLoopback` | `teams`, `friendreq` |
| friend requests, the list, last seen | `Friends.ask` / `gotAsk` / `answered` / `acceptBy` | `friendreq`, `supanet` |
| who owns the party: host, guest, or nobody | `Teams.hostName` / `isHostOf` / the `host` field | `teams`, `friendsnet` |
| the relay's own three sentences | `welcome` / `clash` / `bye` in both relays | `friendreq`, `friendsnet`, `netperf` |
| who says a name is taken twice, per transport | the relay's `hello`, or `Net.clashOn` from presence | `friendsnet`, `supanet` |
| the notification lane and its badge | `Notify.render` / `toast` / `init` | `friendreq` |
| party join / accept / decline / leave | `Net.answerJoin` / `acceptRequest` / `Teams.join` / `leaveParty` | `friendsnet` |

```bash
node lobby-server.js      # the lobby, on port 8787 (or PORT=... / --port N)
node cdp-test.js friendsnet
node cdp-test.js friendreq
node cdp-test.js teams
node cdp-test.js supanet    # the same social path over a Supabase channel
node tools/supa-check.js    # the protocol on its own, no browser needed
```

Hosting the two halves for real - a static host for the game, a process host for
this relay - is a different job from running it on your own machine, and
`DEPLOY-ONLINE.md` covers it: what to run where, the `wss://` URL to paste in, and
the one filename this relay must not have on a host that watches for server
entrypoints (see the note on the name below).

## 1. Running a lobby

`lobby-server.js` has no dependencies - node's own `http`, `fs`, `path`, `os` and
`crypto`, plus the websocket handshake and frame parser written out in the file
(RFC 6455; there is no `ws` package in this project to lean on).

```
node lobby-server.js
  this machine  http://127.0.0.1:8787/
  on your LAN   http://192.168.1.24:8787/?room=isle
  room          isle   (ws://...:8787/isle)
  status        http://127.0.0.1:8787/relay.json
```

It does two jobs:

* **static hosting.** `index.html`, `vendor/GLTFLoader.js`, the `.glb` files and
  their `.glb.js` sidecars, served with the right content types. This is not a
  convenience: a `file://` page cannot `fetch()` its own siblings and cannot
  reach a websocket on another machine, so without HTTP serving there is no
  cross-device path at all. Everything is served out of the folder the script
  sits in and nothing above it (`/../../etc` is refused with 403).
* **the relay.** A websocket endpoint at `ws://<host>:<port>/<room>`. It fans
  every client's JSON out to the other clients in the same room, and that is the
  whole protocol. Two extras, both small:

  * `{t:'hello', id:'<name>'}` is remembered per socket, so a drop - a phone
    locking its screen, a lid closing, a stray Ctrl-W - is announced to the room
    as `{t:'bye', id:'<name>'}` at once instead of waiting for a timeout.
  * a message with a `to` name is delivered only to that socket (public
    presence has no `to` and goes to everyone).

  The **room** is the last path segment or `?room=`, so one relay can carry
  several separate lobbies and they cannot see each other.

## 1b. Or no lobby to run at all: Supabase Realtime

A relay is a process somebody keeps alive. Supabase's Realtime server is the same
thing on somebody else's always-on machine - a client joins a channel, everything
it broadcasts is fanned out to the others - which is the whole of a lobby, so the
game speaks its wire directly instead of a relay's (`Net.connectSupabase`,
`supaPush`, `supaHandle`; no `supabase-js`, so the game keeps its no-build shape).

The panel's **ONLINE** box at the top of FRIENDS takes the same two values as the
build, in two fields - Project URL and key - and that is the whole setup. It is
worth knowing what those two fields do, because they are the entire player-facing
online system:

* `Net.setup(url, key)` validates both halves against the one-line shape, dials
  the project, and stores it in the profile - so the next load dials it by
  itself (the boot order walks link -> room -> saved -> CONFIG -> relay -> probe,
  with the built-in Supabase project first among the ones the build knows).
* `Net.setupInfo()` is the same information the other way round, for the panel:
  whatever the device is on, then whatever was kept from last time, then the
  one the build carries - or `null`, which is what "never been given a project"
  looks like and the only state in which the two fields are shown.
* A build that carries `CONFIG.SUPABASE_URL` never shows the fields at all: it
  opens on `ONLINE - LOBBY - SUPABASE`, and **CHANGE** is the only way to look.
  **GO OFFLINE** means *not connected*, not *forgotten* - the panel says
  `SET UP FOR <url> - NOT CONNECTED` until something dials it again.

The address box under **ANOTHER LOBBY** still takes the one-line form, for a
project somebody sends as text, or a local wifi relay:

```
supabase:https://<project-ref>.supabase.co|sb_publishable_...
```

`Net.supaWire` is the one place that shape is defined: the scheme, the origin, the
key, and nothing else (a bare host or a stray word is refused rather than dialled).
`DEPLOY-ONLINE.md` §1 is the five-minute setup; §2b has what the project is and
the limits of the free plan.

The protocol it speaks, all of it:

```json
-> {"topic":"realtime:isle","event":"phx_join","ref":"1","join_ref":"1",
    "payload":{"config":{"broadcast":{"ack":false,"self":false},
                         "presence":{"enabled":true,"key":"p…"},"private":false}}}
<- {"topic":"realtime:isle","event":"phx_reply","ref":"1","payload":{"status":"ok"}}
-> {"topic":"realtime:isle","event":"broadcast","ref":"2","join_ref":"1",
    "payload":{"type":"broadcast","event":"isle","payload":{"t":"presence","id":"Alice"}}}
<- {"topic":"realtime:isle","event":"broadcast",
    "payload":{"type":"broadcast","event":"isle","payload":{…}}}
-> {"topic":"phoenix","event":"heartbeat","ref":"n","payload":{}}     every 20 s
```

Everything the game already had travels unchanged: `broadcast`'s payload **is** one
of the messages in the set above, on the user event `'isle'`. Two details of the
join carry the relay's behaviour across:

* `broadcast.self:false` - a broadcast never comes back to its own sender, exactly
  like the relay's fan-out, so the game's own messages are never mistaken for
  somebody else's. The client's own-echo drop in `handle` is belt and braces.
* `presence.enabled` - the presence list replaces the two things the relay used to
  be the only one able to do: **announcing a drop** (`presence_diff.leaves` is the
  `bye`; Supabase removes a client's presence the moment its socket dies, so a
  closed page is gone in about 30 ms rather than after the 75 s `PEER_TTL`), and
  **reporting a name used twice** (`clashOn`, the same warning and the same wording
  the relay's `clash` message produces - see `supanet`).

Presence is *not* where the roster comes from. It changes only on join/leave and the
server allows 5 calls per client per 30 s, which cannot say what somebody is doing
right now; the 4 s `announce` heartbeat over the broadcast is still the roster, and
still the same in both transports.

Two things differ from a relay and are worth knowing:

* a broadcast sent before the server has confirmed the join is **dropped with no
  error**, so `send` holds messages until `sb.joined` instead of trusting the
  socket being open - the same rule as a socket still in CONNECTING, and what
  `whyOffline` says;
* a join the project refuses (wrong key, Realtime off, over the plan's channel
  limit) is followed by the game treating that address as dead and walking the
  ones it knows, so the refusal is reported and the lobby moves on rather than
  sitting there looking connected.

`tools/supa-fake.js` is a Realtime server for the tests (same Phoenix protocol,
same server-side RFC 6455 framing as `lobby-server.js`, which is why the relay now
exports `frame` / `readFrames` / `acceptKey`). `scenarios/supanet.js` drives two
real browsers against it; `scenarios/online.js` drives the panel against a build
with the project baked in (the plain link, the two fields, and a reload that needs
neither); `tools/supa-check.js` drives the protocol from Node, and the same
command can be pointed at a real project to check one before a deploy.

## 1c. The lobby you can see

The panel says *who* is online. **LOBBY** (the button on the title bar, or SEE THE
LOBBY in FRIENDS) draws them: everybody the transport is hearing from, standing in
a clearing in the skin they picked, with their name and what they are queuing for
above their head.

```
                    ▲  Alice            ▲  Zoe
                     TRIOS                TRIOS · +1
        (the room)                            ▲  Sam
                                                 SOLO
```

One `Avatar` per player, and the avatar is the *real character*: `Character.preview`
hands back a private parse of the skin's cached bytes and `CharacterRig.build` cuts
it onto the same fourteen hinges the player's own model uses, so
`CharacterRig.pose` runs the identical walk / run / crouch / gun-carry clips. Two
consequences worth knowing:

* **a skin costs what it always cost.** `Character` decodes each skin's bytes once
  for the whole page, so a friend wearing a skin you have already seen costs
  nothing at all, and one you have not costs that one `.glb`, once - the same bytes
  the Locker would have pulled.
* **nothing ever fails to appear.** Until those bytes land, and for a skin that
  cannot be rigged at all, the stand-in is a blocky humanoid built in `Avatar`,
  tinted from a hash of the player's name - so it is the *same colour* on every
  machine, and the room is never a hole where a person should be.

### Where everybody is

The roster says somebody is there; this says where, and it is one message:

```
{t:'pose', id:'Alice', x, y, z, yaw, a}
```

Metres to two decimals, a heading to three, and one animation name (`walk`,
`idle`, `air`, `crouch`, `glider`). ~70 bytes, sent at ~6 Hz (`POSE_MS` = 170 ms in
the Net module) - and **only while something is drawing other players**:

```js
Net.poseOn(myPose)   // the lobby (or, later, a shared match) opened
Net.poseOff()        // it closed
```

That gate is the whole message-budget argument. With nothing drawn, nothing is
sent; with a room of ten, the pose stream is about 6 KB/s in total, and a Supabase
channel's 100 messages/second is nowhere near. It rides every transport, so it
works on a relay and on Supabase without either of them knowing about it.

The far end interpolates rather than snapping (an exponential ease, and
`shortTurn` so a heading never takes the long way round), and the speed the easing
is already travelling at is what drives the legs - so somebody walking on their own
screen walks here, with the cadence of the act. A pose older than `POSE_TTL`
(2.5 s) is not where they are any more: a sender that stopped (their lobby closed,
their socket died) walks their avatar back to its own seat instead of leaving it
frozen mid-stride in the middle of the room.

**Why you walk.** The local player takes a slow lap around the clearing, which
needs no input at all - a Chromebook has a trackpad and no WASD - and it is also
what makes the stream visible: open the lobby on two machines and you can see the
other person walking around in their skin, driven entirely by these messages.

**Why the seats are the same.** Where a standing player belongs comes from a hash
of their *name*, not from the order they arrived in, so two machines draw the same
room and a friend is in the same place in everybody's lobby.

`Avatar.roster()` is what the scenario asserts on - name, skin, position, `moving`,
`model`, `rigged`, `loading`, `failed` - rather than reaching into the scene graph,
and the strip under the room is painted from the same list.

> **Where this is going.** This screen is the first half of "real multiplayer": the
> avatar, the interpolation and the pose stream are what a shared match needs for
> the other players. The match half is the next piece - a host-owned match
> (`{seed, mapId, mode, teamSize}` on the wire, so every machine builds the same
> island, chests and storm from the one seeded `World.build`) with the same `pose`
> message carrying aim, health and weapon, and the host ruling on hits.

## 2. How a second device joins

1. On the machine running the game: `node lobby-server.js`.
2. Open the printed link **on every device** (the same one on a phone on the
   same wifi). The `?room=isle` at the end is what the game reads on boot.
3. Give each device a different player name - **Settings → Player name**. Two
   players with the same name cannot see each other: the wire keys on the name.
   The name is saved with the rest of the profile, so a reload comes back as
   yourself rather than as a stranger called Recruit.
4. Nothing else. The page puts itself in the lobby: a lobby named in the link
   (`?relay=`, and it can be a relay URL *or* a `supabase:` project) wins, then
   `?room=`, then the address this device used last, then the lobby the deploy was
   built with (`CONFIG.SUPABASE_URL`/`KEY` first, then `CONFIG.DEFAULT_RELAY`), and
   failing all of that it asks the host whether it is a lobby server at all
   (`GET /relay.json`) - one cheap request that a file host answers with a 404, in
   which case the lobby stays OFFLINE until something is pasted into the address
   box. That box takes **whatever a friend sends**: an invite link (with or without
   a `?relay=` in it), the address the lobby printed, a bare `host:port`, a
   `ws://…/isle` line, or a `supabase:https://…|<key>` project -
   `Net.normalize` turns any of them into the one address that transport wants,
   with the room in its path or its channel name. **CONNECT** does the same for the
   room code above it (`Net.connect` re-dials the transport already in use, so a
   room-code change on a Supabase deploy rejoins the same project).

   A folder that was copied rather than served is a special case worth knowing:
   `file://` pages cannot be linked, so `COPY INVITE LINK` there hands out the
   relay's own web address (`Net.linkFromRelay`) instead of a page URL - the one
   link that works for somebody who only has the folder. `PLAY-TOGETHER.cmd` in
   the root is the launcher for exactly that session.
5. **COPY INVITE LINK** copies the `?room=` link to send to a friend. Opening it
   lands in that lobby with no clicks at all. When the page is served by a host
   that is *not* the relay - the game on GitHub Pages, the lobby on Render - the
   link carries the relay too (`?room=isle&relay=wss%3A%2F%2F...%2Fisle`), so the
   device that opens it still has something to dial and still joins in one press.
   A relay that is this page's own host is left out of the link, so nothing
   changes for local play.

Once connected:

* everyone else in the lobby is drawn on the roster straight away - no need to
  ADD them first. ADD is what turns somebody you met here into a friend;
* a player queueing DUOS / TRIOS / SQUADS with a free seat appears under
  **JOINABLE PARTIES** with a JOIN button; a party that is closed shows
  **INVITE ONLY** and the button says ASK instead;
* JOIN sends `{t:'join'}`. An open party takes you in immediately and sends back
  the party, which both machines then build their match from; a closed or full
  one turns into a row under **REQUESTS** for the host to ACCEPT or DECLINE.

## 3. Friend requests, and being told about them

Adding a name is still immediate and local - the list has to work with the
transport switched off, and `teams` holds that down - and it now also asks that
player outright:

```
{t:'fask', id, to}   be on my friends list     Friends.ask()
{t:'facc', id, to}   yes - and you are on mine  Net.answerFriend(name, true)
{t:'fdec', id, to}   no                         Net.answerFriend(name, false)
{t:'funf', id, to}   I took you off my list     Friends.remove()
```

* **Asking.** `Friends.ask` keeps the name in the list with `mutual: false`,
  queues the request and sends it. The row shows a gold **REQUESTED** chip and,
  while they are offline, says the request goes the moment they are back.
* **Being asked.** The receiver gets a card in the notification lane - top right,
  over whatever screen is open, because the in-match toast lane lives inside the
  HUD and the menu hides the HUD - with **ACCEPT** and **DECLINE** on it, a badge
  on the menu's FRIENDS button, a count on the REQUESTS tab and a row in the
  panel. All four are painted from the same state, so answering anywhere clears
  it everywhere, and a request survives a reload because it is in localStorage.
* **Answering.** ACCEPT puts them on my list as `mutual: true` and replies
  `facc`; DECLINE replies `fdec` and remembers nothing else. A `facc` on the
  other side marks the friendship both ways, whether or not that machine had the
  name yet - so the two lists agree by construction.
* **Nothing is lost.** Requests are re-sent the moment the other player proves
  they can hear me - their `hello`, and for somebody already in the room their
  `presence`, which is the only thing such a peer ever sends: an outgoing request
  they were not there to hear, and a `facc` they logged off before receiving.
  Both are idempotent on the receiving side (`Friends.gotAsk` answers `'dup'` or
  `'friend'`), so a request only ever has to be made once, everybody hears the
  answer, and `Net.askSent` keeps it to one saying per connection.
* **A request that could not leave says so.** `Net.send` answers whether the
  message actually left the machine, and `Friends.ask` passes that on: a form
  submit with no lobby behind the page answers `ADDED - NOT SENT (NO LOBBY)`, the
  row reads *kept here - no lobby to send it through yet*, and the panel prints
  what is missing (`Net.whyOffline`). The name is kept either way and leaves by
  itself when there is a relay - but "request sent" on a page that sent nothing
  is how a player ends up waiting on a friend who was never told.
* **A decline is honest.** `Friends.declinedBy` takes the name *off* the list
  rather than leaving a one-way row that pretends the friendship exists.

## 4. What the party on another device actually is

A party has one owner: whoever hosts it. The host's roster is the truth. A guest
mirrors it (itself first, then the host's mates) through `Teams.setPartyFrom`, so
`Teams.matchPlan()` on both machines agrees on who is in the squad - which is the
part that matters, because the match itself is still simulated locally on each
machine. What crosses the wire is presence, invites, party membership and the
format; a full network match is a different project.

Leaving is graceful in both directions: `{t:'leave'}` takes you off the host's
party without pretending you logged off, `{t:'bye'}` (sent on `pagehide`, or by
the relay when a socket dies) takes you off the roster. If the host logs off, the
guest's mirrored party dissolves with them (`Net.dropPeer`), and only the owner
can grow a party - a guest that is asked to take somebody in tells them who to
ask instead, so the two rosters can never drift apart.

## 5. Online, and staying that way

Presence is the transport's answer and nothing else: `Friends.online` is
`Net.isLive`, with no pseudo-random flag behind it. A row that says ONLINE is a
peer being heard from this second, and anything else reads OFFLINE with a time on
it (`Friends.seenText`, written when a peer stops being online).

A heartbeat is what makes that state stable: `Net` announces every 4 seconds and
prunes records older than `PEER_TTL` (75 s), repainting only when a signature of
the roster actually changes. Peer records are rich, so a row can say what is
really happening:

```
{ name, party[], mode, host, state, open, friends, skin, at }
```

`state` is the peer's own `App.state`, which is what makes a row read
`RIDING THE BATTLE BUS · TRIOS` or `PLAYING ISLE ROYALE · DUOS` instead of a
guess, and `open` is the host's party privacy (`PARTY: OPEN` / `INVITE ONLY`).
`host` is who owns the party that player is in, and `''` when nobody is hosting
one - which the party list cannot answer on its own, because a guest mirrors the
host's roster with itself first, so `party[0]` is "me" on both machines.

* **The relay has three sentences of its own, and no more.** `{t:'welcome',
  id:'relay', room}` is the greeting: the far end confirming it is really there,
  which is what tells a socket that opened at the edge from a connection that
  works - a filter or a proxy can let the websocket upgrade through and never
  deliver the answer, and the player's end cannot tell that from a slow relay.
  `{t:'clash', id:'relay', name}` goes to *both* players when two sockets
  introduce themselves under one name: the game drops any message whose `id` is
  its own name, so two players on one name are invisible to each other, and the
  relay is the only place that can see it happening. `{t:'bye', id}` when a socket
  dies. A socket that has not introduced itself within `HELLO_MS` (20 s) is closed
  with code 4001 instead of being counted as somebody who is online but silent.
  Everything else on the wire is players talking to each other.

Staying online is the transport's job, and it takes four things:

* **Dialling without being asked.** `Net.autodial` fetches `/relay.json` and
  joins if that is a lobby server; a link's `?relay=`, a `?room=`, or a relay this
  device has used before are all checked first. Nothing about the lobby needs a
  button.
* **A dead socket is dialled again.** `Net.wantOnline` is set by any connect and
  cleared only by GO OFFLINE or by leaving the page. While it is set, a socket
  that closes puts the transport into `RELAY · RECONNECTING` and walks a retry
  ladder (`RETRY_MS`: 1.5 s, 3 s, 6 s, 12 s, then every 20 s) until it is back.
  `visibilitychange`, `focus`, `pageshow` and the browser's `online` event skip
  the wait and dial immediately (`Net.wake`).
* **A background tab keeps its pulse.** Browsers throttle timers in hidden tabs
  to roughly one a minute, so the heartbeat is not only a timer: `Net.handle`
  re-announces whenever a message arrives and the last announce is older than
  `HEART_MS`. Incoming websocket messages are not throttled, so a hidden tab in a
  busy room keeps announcing at the room's own pace, and `wake` says hello the
  moment it is visible again.
* **No ghosts.** A socket that *closes* is announced by the relay at once as
  `{t:'bye'}`, which is why the forgiving TTL only covers a peer that vanished
  silently. Renaming yourself sends `{t:'bye'}` with the old name before
  introducing the new one (`Net.rename`, wired to the Settings field), so a
  rename cannot leave somebody online who is not there. The player's name lives in
  the profile with the room, the relay and the skin, so a reload is still you.
* **Every message is accounted for.** `Net.send` answers whether the message
  actually *left* the machine, and the three cases that used to lose one in
  silence are covered: a message typed while a socket is still opening is held
  (`Net.hold`) and sent the moment it opens (`Net.flush`) - held counts as *not
  sent*, because a socket can sit in CONNECTING for ever; a socket that does not
  open within 15 s is dropped and re-dialled (`dial`'s watchdog), which matters
  because a network that eats the websocket handshake fires no error and no close
  at all; and with no transport the message is not sent and the caller is told so.
  `Net.whyOffline` names which of those three it is, so the panel is never silent
  about why a request has not gone. `Net.wire` also decides the scheme a pasted
  address is dialled with: a page served over https may only open `wss://`, so
  anything that is not loopback is lifted to `wss://` rather than being refused by
  the browser as mixed content - a refusal that is indistinguishable from "the
  lobby is not running".
* **A dead address is not dialled for ever.** Three things can name a relay - the
  link a friend sent (`?relay=`), the address the deploy carries
  (`CONFIG.DEFAULT_RELAY`), and the one this device used last (`Profile`) - and
  they can disagree: a tunnel expires, a LAN address belongs to another house, a
  playground is replaced and its `deno.net` host goes with it. A dial that fails
  *before the socket ever opens* marks that address dead for the session and
  `Net.tryNextAddress` walks `Net.addresses()` in turn - link first, then the
  built-in one, then the saved one - saying what it is doing. Each address is tried
  once per session, so it cannot become a loop, and when none is left the panel
  says where the new address is (the Deno console) and that the invite link a
  friend sends carries it.
* **The clipboard is not assumed.** `Net.copyText` answers through a callback,
  because the async clipboard API can refuse *asynchronously* - which is how a page
  ends up announcing COPIED over an empty clipboard. COPY INVITE LINK reports what
  really happened, and the link also sits in a readonly box (`#inviteLink`) that
  selects itself when it is clicked, so Ctrl+C works even where the page is not
  allowed to copy at all.

## 6. Offline is still a first-class path

Nothing in the match depends on a message arriving. With no transport the panel
says OFFLINE (or RECONNECTING), every friend row reads OFFLINE with a time on it,
and the party plays as AI squadmates - every format still works, which is what the
`teams` scenario covers. The list itself is local: adding a name works with the
transport switched off, and the request that goes with it is simply kept until
there is somebody to send it to. The game says which of the two it is: a kept
request reads NOT SENT (NO LOBBY) and the panel prints what is missing, because
"request sent" on a page that sent nothing is indistinguishable, to the player
doing the adding, from a broken friend.

## 7. What is asserted, and what is not

`scenarios/friendsnet.js` starts the real `lobby-server.js` in-process, serves the real
game over it and drives **two real browser pages** plus raw `WebSocket` clients
through the whole path: HTTP serving and traversal refusal, one-press CONNECT,
presence both ways, the JOINABLE PARTIES row and its JOIN button, the ask, the
host accepting, the party mirrored on both machines, the same squad on both,
invites, the `to`-addressed message path in both directions (a message for
somebody else never reaches a third machine), closing the party, the REQUESTS row
and ACCEPT, `bye` on a drop, a host logging off dissolving the guest party,
`?room=` joining a second room, and that room being a different lobby.

`scenarios/friendreq.js` covers the friends half, and adds two things the older
scenario cannot: the game joining the lobby *by itself*, and **two origins**.
A browser gives every origin its own `localStorage`, so the second device is
served from `localhost` while the first one uses `127.0.0.1` - which is what two
real machines look like, and the only way the checks about a friendship surviving
a reload, or about who is really online, are measuring the right thing. It asserts:
joining with no CONNECT press, a socket that is closed being dialled again, a
request leaving a REQUESTED row behind, the notification card with its two buttons
plus the badge, the tab and the panel row, ACCEPT making the friendship mutual on
both machines, that friendship being there after a reload, DECLINE saying no and
taking the name off the list, a request made while the other player is away being
delivered when they come back (and their yes being understood), an incoming
message re-announcing for a tab whose timer is out of action, a row that reads
OFFLINE with a last-seen time once they leave, every shape of thing a friend can
paste into the address box (an invite link with and without a `?relay=`, the lobby
line, a bare host, nonsense), and - the copy that travels on a stick - a page
opened from `file://` handing out the relay's own address as its invite link and
dialling it again when that link is pasted back.

`scenarios/teams.js` is the no-transport half of the last two: a name added with no
lobby behind the page comes back `sent: false`, and is reported as NOT SENT in the
header, in the row and in the panel (with the fix named) rather than as a request
that went out - and a message handed to a socket that is still opening is held,
then delivered when it opens. It also asserts the link a player sends is really
sendable: in the box, selected by a click, and honest about a copy the browser
refused.

`friendreq` covers both shapes of that link - the short `?room=` one when the
lobby is the host that served the game, and `?room=…&relay=…` when it is not,
which is the Netlify case where the game and the lobby live on different hosts.
It is also where the greeting is asserted: the game records `Net.greeted` from the
`welcome` the relay sends, which is what makes "the socket opened" different from
"the connection works".

`friendsnet` is where the host marking is proved across two machines: the wire
carries `host`, the joinable row for the owner says HOST, the owner's bar says
`HOST: YOU` while the guest's says `HOST: ALICE`, and a guest's party is not offered
as a second door to the same party. A peer that announces no `host` at all - a
build from before the field existed, or a raw client - is treated as the owner of
its own row rather than becoming unjoinable, and `teams` covers that fallback plus
the three states of `Teams.hostName()` (nobody, me, somebody else) with no transport
at all.

Timing note: the polls return the instant their condition is true, but their
windows are generous, because a headless browser with a software renderer can
have its main thread starved for seconds when several scenarios run at once - and
a check that fails on a slow machine is worse than no check.

Not covered, on purpose: two *separate* machines (the harness opens two pages in
one browser - on two origins, which is the storage half of the difference), an
actual networked match, and the https side of `Net.wire` itself - the harness
loads the game from `file://` and from `http://127.0.0.1`, so the rule that a
secure page may only dial `wss://` is carried by the code rather than by a check.

  one turns into a row under **REQUESTS** for the host to ACCEPT or DECLINE.
