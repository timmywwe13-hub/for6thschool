# Putting the game online: GitHub, Netlify, Supabase

**One path, and then it is done for good.** Everything here is in a browser except
the two commands that put the repository on GitHub.

| | what it is | where it goes |
| --- | --- | --- |
| **the game** | `index.html` + ~31 MB of models | **Netlify** builds `web/` from the repository on every push - `netlify.toml` already says the command and the folder |
| **the lobby** | the game's Supabase transport | a free **Supabase** project. Its URL and key are two environment variables on the host, never in git and never pasted by a player |
| **the code** | this folder | **GitHub**, so a push is the deploy and the checks in `.github/workflows/scenarios.yml` run against it first |

What comes out is one link. A Chromebook opens it and is in the lobby: no address
to paste, no app to install, nothing to configure on any player's machine, because
the build bakes the Supabase project into the page (`tools/web-build.js` reads
`ISLE_SUPABASE_URL` and `ISLE_SUPABASE_KEY`).

---

## 1. The path, in five steps

**1. Supabase - the lobby.** Open <https://supabase.com/dashboard>, sign in (free),
press **New project** - any name, any region, ready in a minute or two. Then
**Project settings -> API keys** and copy the two values:

| the value | what it looks like | the name it gets on the host |
| --- | --- | --- |
| Project URL | `https://<something>.supabase.co` | `ISLE_SUPABASE_URL` |
| publishable key | `sb_publishable_...` (older projects: the `anon` key) | `ISLE_SUPABASE_KEY` |

Both are meant to be public - the key can only read a project with no tables in
it, and that is what every Supabase web app ships. No SQL, no tables, no settings
to switch on: Realtime is already on, and the game uses one channel of it (§2c
spells the protocol out and CI checks it against a Realtime server).

**2. GitHub - the repository.** In this folder, two commands (a GitHub account is
free; make an empty repository with no README, then):

```bash
git init -b main
git add -A && git commit -m "Isle Royale"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Nothing secret went with it: `.gitignore` keeps `web/`, `node_modules/` and the
relay zip out, and the two values from step 1 are not in any file.

**3. Netlify - the host.** <https://app.netlify.com> -> **Add new site** ->
**Import an existing project** -> GitHub -> pick the repository. Netlify reads
`netlify.toml`, so the build command (`node tools/web-build.js`), the publish
directory (`web`) and Node 22 are already written down - there is no form to fill
in and no install step (the game has no dependencies).

**4. The two environment variables.** Netlify -> **Site configuration** ->
**Environment variables** -> add `ISLE_SUPABASE_URL` and `ISLE_SUPABASE_KEY` from
step 1. This is the only secret in the whole setup; it lives here rather than in
the repository so that anyone with read access to the code still cannot take the
lobby.

**5. Deploy.** Press **Deploy site**. Every later push to `main` does this by
itself, after the checks in `.github/workflows/scenarios.yml` have run - which
include a build with these two variables, so a push can never ship a page with no
lobby in it. When the deploy is done, open the site: the game loads, and the
FRIENDS panel reads `ONLINE - LOBBY ISLE - SUPABASE - 1 PEER` with no fields in
front of it.

That is the whole setup. **What a player does:** open the link. The room is `isle`
by default, so one link is one lobby; `?room=<code>` in an invite link makes a
second one.

---

## 1b. Without GitHub: drag a folder, then two fields

If you would rather not push to a repository at all, the same game and the same
lobby work from a drag-and-drop deploy:

```bash
node tools/web-build.js                 # -> web/   11 files, 31.6 MB, biggest 8.7 MB
node tools/web-build.js                 # with ISLE_SUPABASE_URL / ISLE_SUPABASE_KEY
                                        # set, the project is baked into web/index.html
```

1. Open <https://app.netlify.com/drop> and drag the **`web`** folder onto it. It
   answers with a live link in a few seconds, no login needed (claim the site
   later by signing up; updating is the same drag).
2. With the two variables set when you built, that link is online exactly as in
   §1 - the project is already in the page.
3. Without them, each machine does the setup once: **FRIENDS -> ONLINE** takes the
   Project URL and the key in two fields and keeps them, so it never asks again.

Why `web/` is smaller than the project: the `.glb.js` sidecars are 41 MB of base64
that exist for one reason - a `file://` page cannot `fetch()` its sibling files,
so the game falls back to a `<script>` sidecar. Served over http(s) the game
fetches the real `.glb` and never asks for them, and every file stays under 10 MB,
which drag-and-drop hosts need.

Other hosts that work the same way: **Cloudflare Pages** (free account, same drag
or the same GitHub import), **Vercel**, **Neocities**, or any web server. GitHub
Pages is fine too but cannot bake the two variables in - use the two fields there
(§6). `scenarios/deployed.js` asserts exactly this shape: a plain file server that
knows nothing about the protocol, the game booting from it, and its models
arriving as real `.glb` files.

---

## 2. The lobby online in one paste: Deno Deploy

*An alternative to the Supabase lobby of §1, for when you want this project's own
relay running rather than somebody else's realtime service - and for hosts where
the two environment variables of §1 cannot be set.*

The lobby has to *stay connected*, so it cannot live on a file host. `relay-deno.js`
in the root is the same relay as `lobby-server.js`, written for Deno so it can run
somewhere you never have to touch. A **playground** is the browser-only way in: it
is created, edited and deployed entirely in the dashboard, with no repository and
no build step to configure.

1. Open <https://console.deno.com> and sign in (a free account; Google login
   works). Make an organization when it asks - the org slug becomes part of your
   relay's address.
2. On the organization's **Applications** page press **New Playground** - *not*
   **+ New App**. A New App wants a GitHub repository and a framework preset, an
   install command and a build command; a playground asks for none of that.
3. Drag **`deno-relay.zip`** from the project root into the playground's file
   browser. It unpacks a zip, and this one holds `relay-deno.js` plus the
   `deno.json` that names it as the entrypoint.
4. Press **Deploy** in the top bar. The URL it shows next to it is your relay:

   ```
   https://<app>.<org>.deno.net
   ```

   That is what a browser can reach; the game wants the same address with `wss://`
   and the room on the end - `wss://<app>.<org>.deno.net/isle`.

Open that URL in a browser: it answers with a page that says the lobby is up and
prints the address the game wants, and `…/relay.json` reports the rooms and how
many players are in each. Nothing else to configure; it is always on, and it is
free for a lobby like this.

**Re-drop the zip when it changes.** It carries the relay's own behaviour as well
as the protocol: the greeting it sends every player, the warning it gives both of
them when one name is used twice, and its patience with a socket that opens and
then never introduces itself. A relay deployed from an older zip keeps working -
the game does not need any of it - it just stays quiet about those.

If a **Build Config** drawer shows an **Install command** or a **Build command**
(`deno install`, `deno task build`), clear both. This relay is one file with no
dependencies and nothing to build, and `deno task build` fails when there is no
`build` task to run. Framework preset: **No Preset**. Runtime configuration:
**Dynamic**, entrypoint `relay-deno.js` - which is what the `deno.json` in the zip
already says, so a playground needs none of it by hand.

> **`dash.deno.com` no longer exists.** Deploy Classic was shut down on 20 July
> 2026, so a `<slug>.deno.dev` address cannot be made any more. The new console is
> <https://console.deno.com> and it answers on `<app>.<org>.deno.net`.

The same file runs on your own machine if you want to poke at it (this is what
the CI-shaped check does):

```bash
deno run --allow-net relay-deno.js      # picks :8000
node tools/relay-deno-check.js          # 9 protocol checks against it
```

---

## 2b. The lobby that needs nobody: Supabase Realtime

§1 is this section as a five-step deploy: create the project, put its two values
on the host, push. What follows is everything the project *is*, for whoever wants
to see it before trusting it to a class - and the browser-only version of the same
setup.

§2 is a process somebody has to deploy. This is the version where nobody runs
anything at all: Supabase's Realtime server already fans one client's JSON out to
the other clients on a channel, which is the whole job of a lobby, on somebody
else's always-on machine. The game speaks it directly - a free project, one paste,
no deploy, no relay to keep alive.

1. Open <https://supabase.com/dashboard> and sign in (free). **New project** - any
   name and region; it is ready in a minute or two.
2. **Project settings -> API keys** has the two things needed: the **Project URL**
   (`https://<project-ref>.supabase.co`) and the **publishable key**
   (`sb_publishable_…`; the older **anon** key works the same way).
3. In the game, **FRIENDS -> ONLINE**: the Project URL in the first box, the key
   in the second, **GO ONLINE**. That is all - the device keeps them, so it is
   the only time it ever asks, and the status line reads `ONLINE · LOBBY <code>
   · SUPABASE · <n> PEER`. The lobby is the channel `realtime:<room code>`, so
   the same room code still means the same lobby, and COPY INVITE LINK is
   everything a friend needs.

   The box under **ANOTHER LOBBY** takes the same project as one line, for when
   somebody sends it to you as text:

   ```
   supabase:https://<project-ref>.supabase.co|sb_publishable_...
   ```

4. For the plain game link to be online for everybody, bake the project into the
   deploy - which is exactly what §1 does on every push, from the two environment
   variables. Doing it by hand:

   ```bash
   ISLE_SUPABASE_URL=https://<project-ref>.supabase.co \
   ISLE_SUPABASE_KEY=sb_publishable_... node tools/web-build.js
   # PowerShell:
   #   $env:ISLE_SUPABASE_URL='https://<project-ref>.supabase.co'
   #   $env:ISLE_SUPABASE_KEY='sb_publishable_...'
   #   node tools/web-build.js
   ```

   Drag `web/` onto <https://app.netlify.com/drop> again and
   `https://<name>.netlify.app/` is online by itself, for everybody, with nothing
   pasted and no query string - and every invite link too, because the one-line
   address rides in `?relay=` exactly as a relay's URL does.

### Check it before you trust it (no browser needed)

```bash
node tools/supa-check.js                                            # the fake server, offline
node tools/supa-check.js https://<project-ref>.supabase.co <key>     # the real project
```

The second one joins a channel of its own (`check-xxxxxx`, so a lobby somebody is
playing in is never disturbed), speaks the protocol the game speaks, and prints
what it found: whether the channel joins, whether a broadcast crosses between two
clients and never comes back to its sender, whether a private message crosses
intact, whether a closed client is known to be gone at once, and whether a second
channel sees none of it. It ends with the one-line address to paste, and the build
command. A wrong key, a paused project, Realtime switched off - each is a failed
check with the reason, instead of a lobby that quietly does nothing.

### What this is under the game

Realtime is a Phoenix channel server in front of a pub/sub, and the game speaks its
wire directly (`connectSupabase` in index.html - about a hundred lines and no
`supabase-js`, so the game keeps its no-dependency, no-build shape):

```
-> phx_join on topic realtime:<room>   config: broadcast {self:false}, presence on
<- phx_reply {status:'ok'}             ...then presence_state
-> broadcast, event 'isle', payload = the game's own message
<- broadcast from the other players
-> heartbeat on topic 'phoenix' every 20 s
```

Two of those options are the whole design:

* **`broadcast.self:false`** - a broadcast never comes back to its own sender, so
  the wire behaves exactly like the relay's fan-out and the game's own messages
  are never mistaken for somebody else's.
* **presence on** - this is what makes a closed page vanish *at once*. Supabase
  drops a client's presence the moment its socket dies, so `presence_diff.leaves`
  is the `bye` a relay announces; without it the only way to notice would be the
  75 s heartbeat window. Presence is also what reports two players using one name,
  which a relay used to be the only one able to see.

The roster itself still comes from the game's own 4 s `presence` *message* over the
broadcast, not from Supabase presence: presence changes only on join/leave, and the
server allows 5 calls per client per 30 s, which cannot say "that player just
queued for squads".

### Is the key a secret? (no - and what that means)

The publishable/anon key is designed to be visible: it is what every Supabase web
app ships, and it cannot read a table unless a policy allows it. What it does let
anybody with the game link do is **join the lobby channel**, which is exactly what
a relay does with a room code. So:

* the game link is the thing to hand out, not the key, and any room code is just a
  channel name - change it and you are in a different lobby;
* if the lobby must be closed to strangers, use a **private channel**: Supabase ->
  Realtime -> Authorization, an RLS policy on `realtime.messages`, and the channel
  joined with `private: true` (one flag in `connectSupabase`). Broadcast and
  presence then work only for authenticated clients.

Never put the **secret** key (`sb_secret_…`, or the old `service_role`) in the
game: that one bypasses RLS and belongs on a server.

### Limits that matter on the free plan

200 concurrent connections, 100 messages/second, 100 channel joins/second, a 256 KB
broadcast payload, 10 presence keys per object. A lobby of ten is nowhere near
them: one ~150-byte presence message per player every 4 s is about 25
messages/second *delivered* with ten in the room. A room of a hundred would be the
one to watch, because the 4 s heartbeat is the part that scales with the square of
the room - `HEART_MS`, at the top of the Net module, is the knob. Notes:
<https://supabase.com/docs/guides/realtime/limits>.

### A relay can stay in the build too

The two are not exclusive. With both baked in, the deploy dials Supabase first and
keeps the relay address as the fallback it walks to when the project pauses or the
key is rotated - `tryNextAddress` in the game walks every address it knows, and
says what it is doing while it does. To drop the relay entirely:
`ISLE_RELAY= node tools/web-build.js` leaves it empty and nothing else changes.

---

## 3. Tie them together with the invite link

The game and the lobby are now on two different hosts. The link that joins them is
the one the game builds for you:

1. Open `https://<name>.netlify.app/` on the machine that is setting things up.
2. **FRIENDS** -> paste the relay into the box under *ANOTHER LOBBY* ->
   **CONNECT RELAY**:

   ```
   wss://<app>.<org>.deno.net/isle
   ```

   `wss://` because the page is https - a browser refuses a plain `ws://` socket
   from an https page - and the `/isle` on the end is the room.
3. Press **COPY INVITE LINK**. The link itself sits in the box above that button,
   so it can be selected and copied by hand where a browser will not hand the
   clipboard over. What you get is the whole thing in one link:

   ```
   https://<name>.netlify.app/?room=isle&relay=wss%3A%2F%2F<app>.<org>.deno.net%2Fisle
   ```

Send that anywhere. A friend who opens it is in the game *and* in the lobby, with
nothing to install and nothing to type - the roster fills in as people arrive,
**ADD FRIEND** sends a request the other side can accept, and everyone's own COPY
INVITE LINK passes the same door on.

**The nicer trick: make the plain link work too.** With the relay address filled
in once, `https://<name>.netlify.app/` is enough on its own - no `?relay=`, no
pasting, for anybody, forever. That address lives at the top of
`tools/web-build.js`:

```js
const RELAY = process.env.ISLE_RELAY !== undefined
  ? process.env.ISLE_RELAY.trim()
  : 'wss://<app>.<org>.deno.net/isle';
```

`node tools/web-build.js` writes it into `CONFIG.DEFAULT_RELAY` in the deploy
folder's copy of the game and prints the address it baked in, so re-dropping `web/`
is the whole job - everybody who opens the plain link is in the lobby with nothing
pasted. One build can use a different relay without editing anything:

```bash
ISLE_RELAY=wss://other-host/isle node tools/web-build.js
# PowerShell:  $env:ISLE_RELAY='wss://other-host/isle'; node tools/web-build.js
# no relay at all:  ISLE_RELAY= node tools/web-build.js
```

`index.html` itself is deliberately left with an empty `DEFAULT_RELAY`. The
scenario harness loads *that* file, and several of its checks are about the
no-transport path - a request kept rather than sent, and the panel saying so - so a
relay baked into the source would have the tests dial the internet instead of the
lobby they start themselves. Substituting it at build time is what makes the deploy
online by default while the tests stay honest.

### If ADD FRIEND "did nothing" on the Netlify link

The two halves of the last two sections are why: the game half cannot send
anything on its own. A static host - Netlify Drop, Cloudflare Pages, GitHub
Pages - serves files and will not hold a socket (§7), so on the plain
`https://<name>.netlify.app/` link there is **no lobby behind the page and a
request has nothing to travel through**. The name is still added, and the request
still goes out by itself the moment a relay is there - nothing is lost - but the
friend hears nothing before that.

The game says so now instead of pretending. With no lobby, ADD FRIEND answers
**ADDED - NOT SENT (NO LOBBY)**, the row under it reads *kept here - no lobby to
send it through yet*, and the FRIENDS panel prints what is missing. Either of
these fixes it, and the second one is the one worth doing:

* **the address, once** - paste the relay's `wss://…/isle` into FRIENDS -> the box
  under *ANOTHER LOBBY* -> **CONNECT RELAY**, then send the invite link;
* **the address, permanently** - put it in `CONFIG.DEFAULT_RELAY`, run
  `node tools/web-build.js`, drag `web/` onto the site again. Then
  `https://<name>.netlify.app/` is online for everybody with nothing pasted, ever.

Two smaller traps used to look exactly like "the lobby is not running":

* **a `ws://` address on an `https://` page.** A browser refuses a plain socket
  from a secure page before a byte is sent, so the pasted line silently did
  nothing. The game now lifts anything that is not `localhost` to `wss://`, and
  when a relay does not answer it prints the address it tried and the reason an
  https page needs `wss://` rather than "is lobby-server.js running?".
* **a request typed while the socket was still opening.** A message is now held
  and sent the moment the socket is up, and a pending request is re-sent on a
  peer's presence - so it arrives whether they join later or were already there.

### If a second device says "nothing is answering there"

That message comes from the game, and it means the address *that device* is
dialling did not answer. It names the address in the same line, so read it first -
it is very often not the relay you deployed:

* **a stale or moved address.** Three things can name a relay and they can
  disagree: the link a friend sent (`?relay=`), the address this deploy was built
  with (`CONFIG.DEFAULT_RELAY`), and the one that device used last. A tunnel
  expires, a LAN address belongs to another house, a playground is replaced and
  its `deno.net` host goes with it - and a `deno.net` host *does* stop existing
  when the app is renamed or deleted: TLS to it fails from every device
  (`ERR_SSL_PROTOCOL_ERROR` in a browser, "nothing is answering" in the game).
  The game walks every address it knows in turn now (link first, then the
  built-in one, then the last used one), skipping any that did not answer, once
  each per session, and says which one it is trying. When none is left it names
  the address it failed on and points at <https://console.deno.com>, where the
  app's URL is shown, and at the invite link a friend sends, which carries it.
  The permanent fix for a moved lobby is the **invite link from the box in
  FRIENDS**, not a bare URL: `?relay=` wins over whatever a device had saved.
* **a network that cannot reach the host.** Open the relay's own address in a
  normal tab on that device (`https://<app>.<org>.deno.net/`). If the dark
  "ISLE ROYALE LOBBY - UP" page does not load there, that network - a school
  filter, a district proxy, an HTTPS-scanning antivirus - is between the device
  and the relay, and nothing in the game can route around it. A phone hotspot for
  a minute tells you for certain, and the same-wifi path (`PLAY-TOGETHER.cmd` on
  the host's PC, plain `ws://` over the LAN) needs no internet at all.

While it is in that state the panel says what it is doing: `RECONNECTING · TRY 3`
followed by the last error or the address, and the roster is empty because nobody
has been heard from.

### If both devices are "online" but neither can see the other

Two players on **one player name** are invisible to each other: the game drops any
message whose `id` is its own name. The relay watches for exactly that and now
warns both of them (`NAME CLASH: SOMEBODY ELSE IS "RECRUIT"`), because nothing on
either machine could have noticed on its own.

### If the room empties itself every few minutes

A socket that opens and then never introduces itself is not a player: something in
the middle let the websocket upgrade through and never delivered the answer. The
relay closes those after 20 s (close code 4001) rather than counting them as
somebody who is online but silent, and the game's own watchdog gives a socket 15 s
to open before dropping and re-dialling it.

---

## 4. One link for this session, from your own PC: `PLAY-ONLINE.cmd`

No accounts anywhere, and one link that is the game *and* the lobby, because
`lobby-server.js` serves both. It needs a PC that can run Node and stay switched
on while people play.

1. Double-click **`PLAY-ONLINE.cmd`** (Windows; on macOS/Linux,
   `powershell`-equivalent: `node lobby-server.js` plus `cloudflared tunnel --url
   http://localhost:8787`).
2. It starts the lobby, opens a free Cloudflare tunnel to it, and prints the link
   to send everybody:

   ```
   https://<random-words>.trycloudflare.com/?room=isle
   ```

   It copies that link to the clipboard and opens it in your browser too, so this
   machine is in the lobby as well.
3. Leave the window open while people are playing. Ctrl-C takes it down and
   nothing of that machine is on the internet any more.

Notes: the link is **new every run** (a quick tunnel is thrown away when it
stops), so send it again each session. Cloudflare's tunnel needs no account, has
no interstitial page, and WebSockets work through it. ngrok also works if it is
what you have (`PLAY-ONLINE` uses it when cloudflared is missing) - its free plan
shows visitors a one-time "Visit site" click and caps traffic at 1 GB/month, which
a 31 MB game will reach with about thirty visitors. If no tunnel tool is found the
script offers to install cloudflared with `winget`.

---

## 5. The folder on a stick (the fallback that always works)

Copied onto a USB stick and handed round, the game plays with no setup at all -
that is what the `.glb.js` sidecars are for - and one person starts the lobby:

1. **The host** double-clicks `PLAY-TOGETHER.cmd` (or runs `node lobby-server.js`).
   Only this machine needs Node.js; the launcher checks and says so.
2. The window it prints has the address to share, and the lobby serves the game
   itself:

   ```
   on your LAN   http://192.168.1.24:8787/?room=isle
   ```

   Everybody on the same wifi opens that, and COPY INVITE LINK on the host hands
   out the same address as a link.
3. A copy with no lobby yet says so in the FRIENDS panel, and its address box
   takes whatever arrives: an invite link, the address the lobby printed, a bare
   `host:port`, or a `ws://…/isle` line. `Net.normalize` turns any of them into
   the one websocket URL with the room in its path.

From a copied folder, `COPY INVITE LINK` hands out the relay's own web address
(`http://192.168.1.24:8787/?room=isle`) rather than a page URL, because a
`file://` page cannot be linked to. It is the one link that works for somebody who
only has the folder.

---

## 6. If you do use git: GitHub Pages + Render

Worth knowing, not required. Both drag-free routes above cover everything without
a repository; this is the tidier one when you want versioning and a permanent
always-on lobby:

* **The game** -> push to a repository, then *Settings -> Pages -> Deploy from a
  branch -> main / (root)*. `.nojekyll` is already in the root (Jekyll silently
  skips `_`-prefixed files, which the harness writes next to the game), and
  `.gitignore` is the publish list.
* **The lobby** -> the same repository on Render (*New + -> Blueprint -> Apply*).
  `render.yaml` in the root is the whole configuration: no build, start command
  `node lobby-server.js`, health check `/relay.json`, free plan. It sleeps after
  ~15 minutes with nobody connected, so the first visitor waits 30-60 s while it
  wakes - the game says `RELAY · RECONNECTING` and keeps dialling by itself, and a
  keep-alive ping to `/relay.json` removes the wait.

`package.json` exists for these hosts too: `npm start` is the lobby, `npm run web`
builds the deploy folder, `npm test` runs a scenario.

---

## 7. Why the lobby is not on the file host

Netlify Drop, Pages, Cloudflare Pages and serverless platforms can all serve the
game and none of them can run the lobby:

* the relay keeps its rooms in memory, and a host that runs one copy of a function
  per request - or one per connection - has no shared memory, so two players would
  sit in the same room name on different instances and never see each other. A
  silent failure is worse than no lobby;
* a serverless socket dies when its instance's maximum duration runs out, so the
  roster would flicker on a timer;
* a file host does not run server code at all, which is exactly what the game half
  needs and nothing more.

Deno Deploy is different because it runs one *long-lived* app, which is why it is
the recommendation above. So is Supabase Realtime (§2b) for the opposite reason:
the sockets are held by somebody else's always-on server, and the game only has to
speak its protocol - which is why that path needs no deploy at all.

### A note on the relay's name

`lobby-server.js` is not called `server.js` on purpose, and the name should stay.
Some hosts watch for a server entrypoint by filename -
`server.{js,cjs,mjs,ts,cts,mts}` in the project root or `src/` - and when they find
one they stop serving the folder and try to boot it as the whole application,
wanting either a `listen()` at import time or a default export that is a handler.
This relay has neither (it listens only when it is the process that was started,
and it exports `start()` for the scenarios), so every request answered:

```
Invalid export found in module "/var/task/server.mjs".
The default export must be a function or server.
```

Renaming it is what made the folder deploy as static files again.

---

## 8. The whole thing, in the order to do it

```bash
# 1. the folder that gets dragged onto Netlify Drop
node tools/web-build.js                 # -> web/   31.6 MB, biggest file 8.7 MB
#    ...online for everybody, with no relay and no deploy (2b):
ISLE_SUPABASE_URL=https://<ref>.supabase.co ISLE_SUPABASE_KEY=sb_publishable_... \
  node tools/web-build.js

# 2. (optional) a relay to test against locally, before deploying one
deno run --allow-net relay-deno.js      # :8000
node tools/relay-deno-check.js          # 9 protocol checks, then Ctrl-C

# 3. the local lobby and its own checks, exactly as before
node lobby-server.js                    # or double-click PLAY-TOGETHER.cmd
node tools/supa-check.js                # the Supabase transport, against a fake
                                        # Realtime server - or a real project:
node tools/supa-check.js https://<ref>.supabase.co <publishable key>
node cdp-test.js deployed               # file host + relay on another port
node cdp-test.js friendreq              # requests, notifications, staying online
node cdp-test.js friendsnet             # two devices through the real relay
node cdp-test.js supanet                # two devices through a Supabase channel
```

Then: drag `web/` onto <https://app.netlify.com/drop>, drop `deno-relay.zip` into
a <https://console.deno.com> playground (Applications -> New Playground), press Deploy, and put the relay's `wss://`
address in `CONFIG.DEFAULT_RELAY` (then `node tools/web-build.js` and drag again).
After that everybody - Chromebooks, phones, anything - only needs the one link.

What a working lobby looks like: the status line reads `RELAY · <n> PEER`, each
device shows the others on the roster with what they are doing
(`RIDING THE BATTLE BUS · TRIOS`), a friend request arrives as a card in the top
right with ACCEPT and DECLINE on it, and closing one page makes that player vanish
from the others at once - the relay announces the drop rather than waiting for a
timeout. `GET <relay>/relay.json` lists the rooms and how many are in them if you
want to check from the outside.


