# Open Grunker

An open-source, self-hostable 3D arena FPS for the browser — heavily inspired by
Krunker.io, written from scratch. Nine classes, six maps, bunny-hopping,
crouch-sliding, quickscoping, accounts, XP, **GR**, skins, profile pictures,
clans, friends you can drop into a match with, clickable player profiles, player
reports, rebindable keyboard *and* controller bindings, and a leaderboard. Every weapon is modelled part by part
and every skin paints it zone by zone, so a finish reads as a finish rather than
a coat of paint. Four-minute matches, eight players to a
room, as many rooms as there are people to fill them, unlimited ammo.

**Live:** <https://grunker.g0x.dev> · **API:** <https://grunker.g0x.dev/api/v1/>

Opening the site drops you straight into a live match — as a spectator. The menu
is an overlay on the real game: the background is a camera orbiting the middle of
the arena, showing the map and everyone playing in it. Nothing sits in the middle
of the screen — the chrome hugs the edges, so the arena stays visible while you
pick a class or a server. One click on **QUICK MATCH** takes a seat in that same
match, with no reconnect and no loading screen.

- **No build step to develop.** The client is plain ES modules a browser loads
  directly; `npm run build` is a Vite pass over the same files that ships them as
  hashed, tree-shaken chunks. Either one is playable — see [Building the client](#building-the-client).
- **No binary assets.** Every weapon, character, map and sound effect is generated
  from code — the built client is 1.2 MB, 325 KB over the wire, most of it three.js.
- **No native dependencies.** Accounts live in SQLite through Node's built-in
  `node:sqlite`; the only runtime dependency is `ws`.
- **Authoritative server** with client-side prediction, entity interpolation and
  lag-compensated hit registration — and it takes the client's word for none of
  it: shot angles are matched against the view that client streamed, the spread
  seed is the server's counter, the rewind comes off a round trip the server
  timed, and simulation steps are spent out of a budget that refills in real
  time. See [the anti-cheat](#the-anti-cheat).
- **Shareable matches.** Every room has a code like `FRA:7K2Q`; the address bar
  reads `grunker.g0x.dev/?game=FRA:7K2Q` while you are in one, and sending that
  link to someone puts them in the same match.

---

## Quick start

```bash
cd /opt/open-grunker
npm install
npm run build      # optional — without it the sources are served as they are
npm start
```

Open <http://localhost:7420>. That's it — the server hosts the API, the realtime
socket *and* the static client, and fills every room with bots so there is
always a match running.

For the full production install (systemd service + nginx vhost):

```bash
sudo bash scripts/setup.sh
```

---

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the server (API + game + static client) |
| `npm run dev` | Same, restarting on file changes |
| `npm run build` | Build the optimised client into `client/dist/` |
| `npm run dev:client` | Vite dev server on :7500 with HMR, API and socket proxied to :7420 |
| `npm test` | Run every suite (movement, combat, lag comp, simulation, keybinds, rooms, progression, two-factor, moderation, accounts, clans, client, charts, admin, build) |
| `npm run check` | Syntax-check the server entry point |
| `npm run vendor` | Re-copy three.js from `node_modules` into `client/vendor/` |
| `npm run db:init` | Create the database and schema (idempotent) |
| `npm run db:stats` | Row counts and the top ten players |
| `npm run db:reset` | **Destroy** the database and recreate it empty |
| `npm run db -- <cmd>` | Any other database command (see below) |
| `sudo bash scripts/setup.sh` | Dependencies, `.env`, database, service, nginx |
| `sudo bash scripts/deploy-service.sh` | Install/restart the systemd service |
| `sudo bash scripts/deploy-nginx.sh` | Install/reload the nginx vhost |

The admin panel runs on its own port: <http://127.0.0.1:7421/admin> from this
machine, or `http://<lan-ip>:7421/admin` from a phone on the same network. Set
`ADMIN_PASSWORD` in `.env` to enable it.

### Building the client

The client is written as ES modules a browser loads unchanged, and that is still
how it is served when there is no build — a fresh clone plays without one.
`npm run build` is the shipping path on top of the same files:

```bash
npm run build          # -> client/dist: the game, then the panel under /admin/
```

Two Vite passes out of `vite.config.js`. They resolve the two specifiers only a
browser understands — `three` from the import map, `/shared/…` from the site
root — tree-shake three.js down to the parts the game actually calls, minify the
rest and write every chunk under a name that is a hash of its own contents:

| | unbundled | built | gzipped |
| --- | ---: | ---: | ---: |
| three.js | 2.09 MB | 537 KB | 131 KB |
| game + shared code | 1.03 MB | 479 KB | 155 KB |
| stylesheet | 155 KB | 109 KB | 21 KB |
| page | 63 KB | 47 KB | 11 KB |
| **total** | **3.34 MB** | **1.17 MB** | **318 KB** |

three.js gets a chunk of its own: it moves with a dependency bump, the game
moves with every patch, so a patch costs a returning player the game chunk alone
rather than the whole download again. The hashes make that safe to cache for a
year, which is what both nginx and the Node static server do with `/assets/`.
The two files whose URLs client code writes out as plain strings — `/check.png`
and `/assets/favicon.svg` — keep their names, and keep a short cache with them.

The panel is a second, separate pass so that its chunks land under `/admin/`
rather than in the public `/assets/` pile: nginx answers that prefix with a flat
404 and the server refuses it from anything but loopback, and a chunk of the
panel sitting in `/assets/` would be downloadable by anyone.

Which of the two gets served is `CLIENT_DIR`. Left unset it is `client/dist`
when a build exists and `client/` when none does; set it to `client` to pin the
no-bundler loop, where an edit is live on reload with nothing to rebuild.

Bundling freezes a copy of `shared/` into the client, and the whole design rests
on that copy matching the server's — so a build has to be redone when `shared/`
or `client/` changes. Forget, and the boot banner names the file you outran:

```
WARN [server]   client   build predates client/js/menu.js — run `npm run build`
```

For a tighter loop than rebuild-and-reload, `npm run dev:client` runs Vite's dev
server on :7500 with hot module replacement, proxying the API, the avatars and
the game socket to a server already running on :7420.

### Service management

```bash
sudo systemctl status  open-grunker
sudo systemctl restart open-grunker
sudo systemctl stop    open-grunker
journalctl -u open-grunker -f          # live logs
```

### Mail

```bash
npm run mail:test -- you@example.com   # send one message with the current .env
```

Prints the server, port, encryption and sender it is about to use, then
delivers — or explains why it could not, in the SMTP server's own words.

### Database CLI

```bash
node scripts/db-cli.js help

node scripts/db-cli.js stats                    # counts + top players
node scripts/db-cli.js users [limit]            # list accounts
node scripts/db-cli.js admin   <username>       # grant admin
node scripts/db-cli.js mod     <username>       # grant moderator (can mute in game)
node scripts/db-cli.js demote  <username>
node scripts/db-cli.js ban     <username> [days] [reason]
node scripts/db-cli.js unban   <username>
node scripts/db-cli.js mute    <username> [minutes] [reason]   # chat ban only
node scripts/db-cli.js unmute  <username>
node scripts/db-cli.js passwd  <username> <new password>
node scripts/db-cli.js delete  <username>       # asks for confirmation
node scripts/db-cli.js prune                    # drop expired sessions
node scripts/db-cli.js reset --yes              # wipe everything
```

---

## How to play

### Finding your way around the menu

Everything past the play buttons opens as one panel with a **rail down the left**:
one column, grouped by what you came to do — **PLAY** (class, skins, challenges),
**COMMUNITY** (friends, clans, leaderboard, servers), **YOU** (your account),
**SETUP** (controls, settings) and **ABOUT** (how to play, patch notes). Each
entry is an icon and a word, so a destination has a silhouette as well as a name,
and the page you land on says what it is and what it is for in its own header.

There is a **filter box** over the rail for the twelfth visit, when you know the
word and do not want to go looking for it. It matches what a page is *for* as
well as what it is called, so "crosshair" finds SETTINGS and "tag" finds CLANS;
`Enter` goes straight to the first thing left standing.

This replaced a single wrapping strip of twelve words. A strip that wraps has no
shape: nothing sat near anything related to it, the row a name was on moved with
the window, and the only way to find anything was to read all of it.

### Controls

Every one of these is rebindable under **CONTROLS** in the menu — keyboard keys,
mouse buttons, the scroll wheel and controller buttons all work, with three slots
per action: primary, alternate, and the pad. These are the defaults:

| Key | Pad | Action |
| --- | --- | --- |
| `W` `A` `S` `D` | Left stick | Move |
| — | Right stick | Look |
| `Space` | `A` | Jump — tap it on every landing to chain hops. While dead it is also the [kill cam](#the-kill-cam) skip |
| `Shift` / `C` | `B` | Slide — crouch at speed for a burst, then keep hopping. Carves toward your crosshair |
| `Left click` | `RT` | Fire |
| `Right click` | `LT` | Aim down sights / scope |
| `R` | `X` | Reload (ammo is unlimited, so reload whenever) |
| `1` `2` `3` | `D-pad` ↑ ↓ ← | Primary / sidearm / knife |
| `Q` | `Y` | Last weapon · `V` / `R3` quick melee · wheel or `LB`/`RB` to cycle |
| `N` | `L3` | Launch the nuke — live only while a twelve-kill streak has earned one |
| `Tab` | `BACK` | Scoreboard · `Esc` / `START` menu |
| `Enter` / `T` | — | Chat (needs an account at level 2) · `B` / `D-pad →` change class, or your [perk](#perks-choosing-what-kind-of-player-you-are) in the mode that has them |
| `M` | — | Toggle minimap · `F` toggle FPS counter |

**Movement is the game.** Ground speed is capped, but air acceleration is not:
hold a strafe key and turn the mouse smoothly in the same direction while
airborne and you accelerate well past base speed. Sliding grants an instant
burst — slide, jump out of it, then air-strafe to keep the speed.

Bunny-hopping is a rhythm you play, not a key you lean on. Every hop needs its
own press — holding jump gets you exactly one — but the timing around each press
is deliberately forgiving: the landing tick skips ground friction entirely, so a
chain of hops keeps everything you built up; miss it and friction stays soft for
another 180 ms, so a late hop still costs you almost nothing; and a press is
buffered 220 ms early and forgiven 160 ms late. Sliding works the same way: one
press, one slide.

Both are edge-triggered in `shared/movement.js` off the previous tick's key
mask, which the client records **per queued input** rather than in the movement
state. Every server snapshot rewinds prediction and replays whatever is still in
flight, and a replay reading the state's own copy would compare the first
replayed input against the last one — swallowing exactly the fresh press still
on the wire.

**Momentum follows your crosshair.** Hopping or sliding, with no strafe key
held, your speed turns to point wherever you are aiming — a slide carves hard,
a hop about half as hard. Nothing is spent doing it: the direction of your
velocity rotates and its length does not change, so you carry every unit of
speed you earned through the turn. Sliding round a corner is a matter of looking
round it.

**Holding `A` or `D` takes the wheel back**, and that is deliberate. Air-strafe
speed comes entirely from the angle between where you are going and where you
are pushing, and steering exists to close exactly that angle — measured, any
amount of carve at all collapses a strafe run from about 3.1× base speed to
1.4×. So the two take turns rather than fighting:

| What you are holding | What happens |
| --- | --- |
| Nothing, or `W` / `S` | Your speed comes round to where you are looking |
| `A` or `D` | The classic air-strafe, untouched — turn the mouse with it and accelerate |

Let go of the strafe key and your momentum comes round to the crosshair; grab it
again and you are building speed instead of aiming it. Below about 5 u/s neither
one steers: carving is momentum being redirected, and a standing turn that
pivoted the body on the spot would read as ice rather than speed.

### Dying

**You respawn on your own.** The timer runs down and you are back in the match —
there is no key to press. Press `Esc` in the seconds before it lands and you stay
down for as long as you want; closing the pause card puts you back in, and the
jump key still works as the short way there. Anything that wants the mouse — the
class picker, the scoreboard, the chat, the end card — holds the respawn open
the same way, so nobody is ever thrown back into a firefight mid-sentence.

#### The kill cam

**Being killed by another player replays the last ten seconds of the fight
through their eyes.** Not a camera circling the winner: the whole scene rewinds
with you — every player, every body that fell, your own body walking into the
shot — and plays forward at real time from inside the killer's head, with their
view angles. The flick they made is the flick you see. It is letterboxed, with a
strip under the card counting down to the moment you die, and their name, level
and clan, the weapon, the range, whether it was a headshot, and how much health
they had left when it landed — which is very often the most interesting number
on the screen.

**There is no recording.** Every client already holds a ring of the server's
snapshots and already interpolates a moment out of it — that is what draws
remote players a fraction of a second behind live, and has since the first day
of network play. The only thing standing between that and a replay was the
*length* of the ring, so the ring got longer and the cam asks it for a timestamp
ten seconds old. A replay that shares one interpolator with live play cannot
drift from live play, and there is no second copy of "where was everybody" to
keep in step with the first.

The one thing a snapshot does not carry is your *own* entry — the server cuts it
out, because your client is predicting it — so the client hands its own position
and view angles to the same ring. Without that the replay would be the killer's
ten seconds with the person they were shooting at missing from them.

**The orbit is still there, as the fallback.** A slow quarter-turn around the
killer is what runs when there is no history to replay: dying a few seconds
after spawning, dying to somebody who has since left the room, or the last
twenty seconds of a video creator's thirty-second [director's
cut](#creator-status), which is longer than the ring is deep. It is also what
you get by turning **SETTINGS ▸ KILL CAM ▸ REPLAY THE FIGHT FROM THEIR EYES**
off, which is a real thing to want: ten seconds of somebody else's mouse is not
everybody's idea of a good time.

**The interface goes with the shot.** A crosshair, a magazine and a minimap of
the *present*, all of them about a body lying on the floor and half of them ten
seconds newer than the picture, used to sit on top of the cam. They now fade out
for its duration; the scoreboard, the chat and the end-of-match card stay,
because each of those is something a dead player deliberately opens.

**So does the world.** Real time keeps running while you watch, and every
gunshot, spark and explosion arriving during those ten seconds belongs to *now* —
so none of them is drawn or played over a picture of ten seconds ago. A rocket
already in the air is the exception: it is flown and disposed of exactly as it
would have been, and only its mesh and its exhaust are hidden, because the
explosion that removes it has to find it where it really is the moment the cam
hands the screen back.

**You can skip it from three seconds in.** The bar under the button fills until
then, so the wait explains itself. Three is not a compromise between the ten and
impatience: it is long enough that the cam has said what it came to say, and past
`RESPAWN_TIME`, so pressing skip really does put you straight back in rather than
into a wait the cam was hiding. The jump key does it as well as the button — and
that now includes **A on a controller**, which it did not before: the pad layer
only reported the *discrete* actions on a press and left held ones like jump to
be polled, so a player holding a pad had no way past the card except to reach
for the mouse. The button itself names whichever key or button is in your hands.

**It is meant to look like footage.** Three things stood between it and that,
and none of them was the replay itself. The server broadcasts thirty times a
second, and a straight line between two of those changes direction at every one
— invisible on a body across the map, and the whole picture with the camera
standing *inside* one, so the replay fits a curve through the snapshots either
side instead. On top of that a first-person view carries the killer's landing
jolts and every twitch of their mouse, all of it real and all of it unwatchable
from inside their skull for ten seconds, so a light filter takes the top off it
while leaving the movement that reads as *them* — a flick still snaps, it simply
does not ring. And the hand-off from the replay to the orbit used to ease the
camera's position across while cutting its orientation, which was a whip pan on
the one frame nobody expects one; the orbit aims itself now, so the whole
hand-over is one move.

What is deliberately *not* smoothed is the playback clock. It advances by the
real frame time, so what you see always matches how much time has passed — a
long frame shows a bigger step because a bigger step is what happened. Feeding
it an averaged frame time decouples the two and is biased upward besides, which
in testing played the replay half again as fast as the match it was replaying.

**None of it is a rule the match enforces.** The room's respawn timer is
untouched; the cam holds your respawn by *not asking for one*, exactly the way an
open scoreboard already does. A client that skipped every frame of it would
respawn at the same 2.6 seconds as one that watched.

The plain death screen is still there and is still what you get when the world
killed you, when whoever did has already left the room, or when you have turned
the cam off under **SETTINGS ▸ KILL CAM** — where you can also stop it holding
for the full ten seconds and have it end the moment the skip lights up.

**If the person who killed you is a music creator, their track plays over it.**
See [player anthems](#player-anthems). If they are not one there is no sound at
all, which is the ordinary case.

### Settings

**Settings live in your browser, not in an account.** Every change is written to
`localStorage` the moment you make it, so a guest who has never signed in keeps
their sensitivity, their crosshair and their video preset across sessions like
anybody else. Signing in adds *syncing* between devices — it has never been what
makes them stick — and **SETTINGS ▸ BACKUP & SYNC** can export the lot to a file
and read it back, key bindings included, with no account at all.

**Double-click any number** in the panel and type the value you want. A slider is
the wrong instrument for "1.37 exactly", and sensitivity is the setting people
most often want to carry over from another game to the digit. Out-of-range values
are clamped and snapped to the slider's own grid rather than refused.

A few switches worth knowing about:

| Setting | What it does |
| --- | --- |
| **Language** (LANGUAGE) | Eight of them — see [languages](#languages). Automatic follows your browser |
| **Sensitivity while aiming** (AIM) | A multiplier on the sensitivity above it, applied only while the sights are up: below 1 the view slows down when you aim, which is what a scope wants, and 1.00 keeps the same speed everywhere. It steers a controller stick as well as a mouse |
| **Mouse acceleration** (AIM) | Off — the default — asks the browser for raw mouse input, so the same physical flick is always the same number of degrees. On lets your operating system's pointer acceleration through. Changing it re-asks for the pointer lock, so it lands on the next mouse movement rather than the next time you alt-tab |
| **Saturation** and **Contrast** (VIDEO) | The colour grade, as multipliers on the game's own look. 100% is exactly what the maps were painted against, so somebody who never opens these pays nothing for having them |
| **Hide the weapon while aiming** (WEAPON) | Clears the gun out of the bottom of your screen the moment you aim. Yours alone — everyone else still sees you holding it |
| **Replay the fight from their eyes** (KILL CAM) | The [kill cam](#the-kill-cam) as a replay from inside the killer's head, or as the orbit around their body |
| **Spectator** | The chase camera and the through-walls view, both also on `V` and `X` while watching |

**The grade is applied wherever it can be.** With post-processing on, saturation
and contrast happen inside the composite pass, in linear light, before the
vignette and the grain — the right place for them. With post-processing off there
is no composite to put them in, so the same two numbers are handed to the
browser's compositor as a CSS filter on the canvas instead. It is exactly free
while both sit at 100%: the filter string is empty and there is no extra layer to
composite. What it avoids is the worst kind of setting, which is one that moves
and does nothing.

### Languages

**The interface ships in eight languages**: English, Français, Español, Deutsch,
Português (BR), Italiano, Русский and 简体中文. **SETTINGS ▸ LANGUAGE** picks one;
*Automatic* — the default — follows your browser, and an operator running a
server for one country can set the fallback for everybody who has not chosen with
`DEFAULT_LANGUAGE` in `.env`.

**Nothing a player wrote is ever translated.** Nicknames, clan tags, chat lines
and the names people gave their listings are short strings that could collide
with a table entry — a player called "SCORE" must not become "PUNTUACIÓN" — so the
parts of the page they live in are marked and the translator stops at them.

**The key is the English sentence itself.** There is no `en.js` and no table of
symbolic names: `client/js/i18n/<lang>.js` maps the English as it is written in
the source to the translation, and anything not in it renders as the English
somebody actually wrote. That is the one fallback that cannot rot — with six
hundred strings across sixteen hundred lines of markup, a separate English table
would go stale the first time anybody edited a button, and the button would
silently go back to saying whatever it used to say. Editing the markup is editing
the key: the new sentence is untranslated until somebody adds it, which is honest,
rather than translated into the old sentence, which is a lie. `npm test` checks
both directions — that every key still matches a string the client can draw, and
that no language has drifted behind the others.

**An English player pays nothing for it.** No dictionary is fetched, no observer
is created and no walk of the document ever runs: the whole thing returns on its
first line while the language is English, which is what it is for everybody who
has not chosen otherwise. Picking another language fetches one small chunk.

Translating a string that is *assembled* — anything with a number or a name in
the middle of it — needs the call site, so those go through `tf('SKIP IN {n}',
{ n })` with named holes, because word order is exactly what a translation
changes. Everything else is translated where it lands, by a pass that watches for
markup arriving; a panel drawn by code that has never heard of `i18n.js` comes
out translated anyway.

### Playing on a controller

Plug a pad in and it works. There is nothing to enable and no separate mode: the
same action table drives the keyboard, the mouse and the pad, so every action,
every rebinding and every on-screen hint already knows about it.

| In a match | |
| --- | --- |
| **Left stick** | Move. Thresholded into the same eight-way mask the server replays — see below |
| **Right stick** | Look, as a *rate*: how far the stick is pushed is how fast the view turns |
| **`RT` / `LT`** | Fire / aim. Analogue, so a feathered trigger is not a trigger pull |
| **`START`** | The menu. Reserved, exactly like `Esc` — a pad with no way back to the menu is a pad that cannot leave the match |

| In the interface | |
| --- | --- |
| **Either stick, or the d-pad** | Move the highlight, geometrically: "down" from a card in a grid is the card underneath it, not the next element in the document |
| **`A` / `B`** | Press this · step back. `B` closes whatever is on top, and closes the menu when nothing is |
| **`LB` / `RB`** | The page either side of this one, straight down the rail |
| **`LT` / `RT`** | Scroll a page of whatever is scrolling, repeating while held |
| **`Y`** | The filter box over the rail — the fastest way across twenty pages |

**Every button on the pad does something in the menu, and the whole interface
answers to it.** That was the gap: a pad could play the game but not press PLAY
with it. Three things were missing and are now there.

*Sliders, dropdowns and colours are values, not places.* With one focused, left
and right change what it says rather than walking off it — a step at a time on a
slider, an option at a time in a dropdown, and along a short palette for a colour
input, which is an operating-system window no pad gesture can open. Without this
a controller could reach every setting in the game and move exactly none of them.

*Half the interface is cards.* A class, a server, a finish, a case, a discipline:
every one is a `div` with a click handler, because each contains a heading and a
list, and wrapping that in a `<button>` is markup a screen reader reads as one
very long label. A mouse presses them; the browser's own focus order cannot see
them at all. They are now made focusable as the pad walks past — which also means
a keyboard and a screen reader can reach them, which they never could.

*A controller cannot spell.* So the letters come to it: pressing `A` on a text
field opens an on-screen keyboard, and `DONE` commits — sending the line, when
the field is the chat. Every key on it is a real `<button>` in the document, so
the pad's own focus walker steers it and the keyboard itself contains no
navigation code, no focus model and no key repeat. It works with a mouse and a
touchscreen for free.

*"Are you sure?" was a window a pad could not close.* Every irreversible action —
giving up creator status, deleting an anthem, buying a skin outright, following a
link off the site — asked through the browser's own `confirm()`, which is an
operating-system window and takes no controller input at all. Those questions are
now asked in the page, out of the same two buttons every other card is built
from, with focus starting on the safe half.

A legend along the bottom of the screen says what `A`, `B`, `Y` and the bumpers
do. It appears only once a pad has actually been *used* — one plugged in and
never touched changes nothing on screen — and only while an interface, rather
than the match, is what a press is aimed at. That last distinction is its own
fix: standing in a match with the class picker, the pause card, the end-of-match
vote or the scoreboard open, every face button used to keep firing the *game's*
action at it, so a pad could open all four and press nothing on any of them.

**The left stick is thresholded rather than smuggled in as an analogue
magnitude.** The movement step is shared code that the server replays against
your inputs; a magnitude the authority does not agree with is a correction every
tick. Nothing is lost that the game uses — air-strafe acceleration comes from the
*angle* between where you are going and where you are pushing, never from how
hard you are pushing.

**Aim assist is the honest kind, and it is a slider.** While your crosshair is
already on an enemy the look stick slows down, by up to
`gamepadAimAssist` (55% by default). Nothing is ever pulled toward a target and
nothing snaps. A pad cannot make the micro-corrections a wrist makes, and slowing
the turn is what buys the time to; magnetism would be aiming *for* the player,
which is a different thing wearing the same name. The cone is the angle the body
actually subtends at its distance, so the help is generous across a room and
nearly nothing at forty metres — and it only ever considers enemies the client
can genuinely see, the same line-of-sight test that gates a nametag.

Everything else lives in **SETTINGS ▸ CONTROLLER**: stick speed per axis, the
response curve, the deadzone, inverted look and vibration. **Sensitivity while
aiming**, under AIM, steers the stick as well as the mouse. The button layout is
in **CONTROLS**, in a third column of its own — a controller layout is a layout,
and it is rebound and reset as a set without touching the keyboard scheme.

Chat is the one action with no pad button by default, and not because it would
not work: bind it and it opens a line the on-screen keyboard can write. It stays
unbound because every button on a standard pad is already spoken for, and taking
one from firing or from the weapon wheel to give to the chat is a trade a player
should make deliberately rather than find already made.

### Joining a match

The client connects the moment the page loads, as an invisible spectator: it
takes no part in the match, appears on nobody's screen, cannot shoot or chat,
and does not occupy one of the eight seats. **PLAY** promotes it to a real
player in place — a single `pl` message, no new connection.

Each room carries a stable code, `<REGION>:<four characters>`, derived from the
room id so a link keeps working across restarts. The client mirrors it into the
address bar (`/?game=FRA:7K2Q`), and anyone opening that URL lands in the same
room — watching it first, exactly like everyone else. A full room can still be
watched; only taking a seat needs space.

### Spectator mode

The menu's backdrop is a camera orbiting the arena. **Spectator mode** is the
other kind of watching: you sit behind another player's eyes, seeing what they
see, at their aim and their eye height, with their own body hidden so the view is
theirs and not a shoulder in the way.

The switch lives above the build chip in the bottom-left corner of the menu, and
on the pause card. It greys out and refuses the cursor whenever there is nobody
else in the match — an empty arena has no point of view to borrow — except for a
watcher who is already watching, whose switch stays live because it is their way
back into the match.

**When it lands depends on where you are standing:**

- **Not spawned** — in the menu, dead, or between rounds — it takes over
  immediately.
- **Alive, mid-match** — it is *armed*, and the next death honours it. A body
  cannot vanish out of the world in front of the people shooting at it, so the
  switch waits for the one moment it can leave without anybody seeing something
  impossible.

`A` / `D`, the arrow keys, the mouse wheel or a click move to the next player,
and the camera moves on by itself when the one you are watching dies or leaves.
`Esc` opens the pause card; **JOIN THE MATCH** on the bar puts you back in a seat.

**You get the whole interface, drawn from the player you are watching.** Their
health, their weapon and their magazine, their class, their crosshair, and the
minimap from where they are standing — plus the killfeed, the standings, the
scoreboard on `Tab` and the chat, which belong to the match rather than to any
one person. Only the magazine needs the wire's help: every other number is
already in the snapshot entry for that player, so a spectator's snapshot carries
one extra field, `sa`, for the body its camera is on and nobody else's.

Two switches sit on the bar, and both are remembered between matches:

| Key | What it does |
| --- | --- |
| `V` | Swap between their eyes and a chase camera behind them. The boom is traced back from their head and pulled in to whatever it hits, so a fight inside a building is watched from inside it |
| `X` | See every player through the walls. Spectator-only, and unapologetic — a camera with no body in the match has nothing to gain from it but a view of the fight, and the nametags and minimap follow it |

Watching is not playing: a spectator holds no seat, appears on nobody's screen,
and can neither chat nor report — both say so rather than leaving a dead key.
**Your scorecard is parked, not lost.** It is kept exactly the way a disconnect
keeps it, so sitting back down inside the same match picks it up where you left
it. Turning the switch off puts you back where you came from: into the match for
someone who was playing it, and back to the menu for someone who has still never
pressed **PLAY**.

### Chat

**One chat per match.** It is the room's, not the server's: it holds the last
**50 lines**, anyone who joins mid-match is handed them so they arrive knowing
what was said, and the whole thing is **purged when the match ends**. The
fifty-first message pushes the first off the end rather than shutting the room
up — nobody loses the chat halfway through a game. Live match chatter (joins,
leaves, captures, ladder promotions) is shown but never replayed; player
messages and moderation notices are what a latecomer gets.

Press the chat key to open it and the whole log comes back, scrollable. Closed,
only what is still recent stays on the corner of the HUD — **every line the same
way, moderation notices included.** A ban or a mute is loud while it happens and
then gets out of the corner like any other message; it is never deleted, so
opening the chat still brings it back with the rest of the log.

**Writing needs an account at level 2 or above**, and crossing that level
unlocks it there and then rather than on the next page load. Reading is open to
everyone — guests, level-1 accounts and spectators all see the chat, they simply
cannot write into it, and the hint under the log says which of those they are rather
than opening an input whose messages go nowhere. A guest name costs nothing to
make, which is the whole reason the gate is on the account rather than the name.

Every line carries the badges its sender wears, drawn identically here and in the
killfeed, the standings and both scoreboards:

| Badge | Meaning |
| --- | --- |
| `12` | Account level, in front of the nickname |
| `[TAG]` | Clan tag |
| ✓ | Verified account (`/check.png`) |
| `MOD` `ADMIN` | Role, from the account's `role` column |
| `MUTED` | Chat-banned — scoreboards only |

The role chip is left off the killfeed and the mini standings on purpose: both
are 232px wide, and two `ADMIN` chips on one row would leave the names two
characters each. Everywhere with room shows the lot.

### Moderating from the scoreboard

An account whose role is `mod` or `admin` gets a **CHAT** column on the
scoreboard. The scoreboard key *pins* the board open and hands the mouse back
rather than showing it only while held (press it, or `Esc`, to close) — that is
true for everybody now, because every nickname on the board is a link to that
player's profile. Each row carries the mute lengths — **5M · 1H · 1D · ∞** — and
`UNMUTE` for anyone already muted.

The only power on offer is the **chat ban**: a mute takes nobody out of the match
they are playing, it only closes the chat to them. Rank is checked on the server
and strictly — equal ranks cannot touch each other, so two mods can never silence
one another and an admin cannot be silenced by their own staff. Buttons the
server would refuse are not drawn at all. Every mute is announced in the room's
chat, naming who issued it, and it survives a reconnect because it lives in the
database rather than in the room.

### God mode *(administrators only)*

An account whose role is `admin` gets one more control on the scoreboard: a
**GOD MODE** switch in the footer. The scoreboard key pins the board open with
the mouse free, so it is a click away mid-match.

While it is on:

* **Nothing can hurt you.** Bullets, melee, rockets, splash, fall damage, the
  kill plane under the map and even a nuke all stop at the same place — one
  check inside `applyDamage`, so a new source of damage cannot forget it.
* **You fly.** Gravity, friction and ground state are switched off entirely and
  the crosshair becomes the throttle: `W`/`S` fly where you are looking, `A`/`D`
  strafe, `Space` climbs and `Ctrl` descends. Collision stays on — this is
  flight, not noclip, because an admin walking through a wall cannot be shown
  what is behind it.
* **The magazine never empties.** Every magazine is topped up on the way in and
  the room stops counting rounds out of them, so there is no reload to sit
  through — the counter reads `∞`, the way a blade's and the reserve already do.
* **Nothing is waited on.** The fire rate, the bolt, the draw left over from a
  swap and the knife's swing all collapse to `GOD_SHOT_INTERVAL` — twenty rounds
  a second, so the trigger is the only limit left and a launcher empties as fast
  as you can click it. It is a floor and never a ceiling: the akimbo uzis are
  already quicker and keep their own rate. Twenty rather than *none* because no
  wait at all is one round per rendered frame, which on a fast display is an
  input stream the packet-rate guard reads as a speedhack and a tracer broadcast
  to the room two hundred times a second.

It is deliberately narrow:

| | |
| --- | --- |
| **Who** | `admin` only. A `mod` has the chat ban and nothing else — the gap between "can silence someone" and "cannot be shot" is exactly where that line belongs. |
| **How long** | As long as the socket. It is never written to the database, so a reconnect, a rejoin or a server restart always comes back mortal. |
| **Re-checked** | Every press. An account demoted mid-session loses it the next time it presses the button, not the next time it signs in. |
| **Recorded** | Both directions are written to the admin log as `god_on` / `god_off` with the room, map and mode — so the operator can find it afterwards without having to be told about it. |
| **Visible to you** | A **GOD MODE** badge sits under the crosshair the whole time it is on, and the ammo counter reads `∞`. Nobody is invincible by accident. |

The server is the only thing that decides. The client asks (`gd`), the room
re-reads the rank, and the badge and the switch are drawn from the answer that
comes back — pressing the button never turns anything on by itself.

> One thing to know before handing out the `admin` role: god mode does **not**
> stop you scoring. An invincible administrator can still shoot people and still
> earns kills, streaks and GR from them. That is the same trust the role already
> carries everywhere else in this project, and the audit log is the check on it —
> but it is worth saying out loud rather than discovering.

### Reporting a player

Every signed-in account at **level 5 or above** gets a **REPORT** column on the
scoreboard, which the scoreboard key opens with the mouse free so the buttons can
actually be clicked (press it, or `Esc`, to close). Your own row and the bots have
no button. The gate is deliberately higher than the chat's: a bad chat line costs
one person one line, while a bad report costs a moderator the time of every real
report it buried.

**A refused button is drawn, not hidden.** Below the level, inside a cooldown, or
switched off for your account by a moderator, the button is still on the row —
greyed, refusing the cursor, and carrying the server's own sentence for why.
Hover it to read that sentence, or click it to be told out loud. Every reason it
is off is something you can do something about, and none of that is learnable
from an empty cell.

The button opens a card with five reasons — **cheating · chat abuse · offensive
name · griefing · something else** — and an optional line of your own words. A
reason is mandatory, because "reported" on its own is a queue entry no moderator
can act on.

**The server fills in the rest.** The report is filed through the game socket
rather than the REST API, so the room itself supplies who the target really is,
which match, map and mode it was, the address they were playing from and a
snapshot of the last 25 chat lines. A moderator reading the queue an hour later
gets the context the match threw away when it ended, and nobody can report a
name they made up.

Nothing is announced. Only the reporter is told, privately, that it was filed:
the room never learns who was reported or by whom, which is what stops a report
from being a weapon.

**The button has ceilings, and each one answers a different way of abusing it.**
A report costs the person filing it nothing and costs a moderator a minute of
reading, so the only thing keeping the queue worth reading is that no single
account can fill it. Every one of them is enforced by the server at the moment
of filing — the browser only ever hides a button the server would refuse anyway.

| Rule | Default | Why |
| --- | --- | --- |
| Not blocked by a moderator | *(admin panel)* | The only one a human issues by hand — see below |
| Account, level 5+ | `REPORTS_MIN_LEVEL=5` | A fresh throwaway account is not a witness |
| 60 s between any two reports | `REPORTS_COOLDOWN_SEC=60` | One incident at a time, not a burst |
| 6 an hour | `REPORTS_MAX_PER_HOUR=6` | A bad evening cannot bury a week of real reports |
| 15 a day | `REPORTS_MAX_PER_DAY=15` | …and the hourly cap cannot simply be waited out all night |
| 5 still open at once | `REPORTS_MAX_OPEN=5` | Reports nobody has read yet are not an allowance to spend |
| 10 minutes before the same target again | `REPORTS_REPEAT_COOLDOWN_SEC=600` | One incident, one queue entry |
| 5 dismissals in 7 days → 24 h shut out | `REPORTS_DISMISSED_*` | Crying wolf costs the next day of reporting |
| A bot, or yourself | never | There is nobody to answer for it |

Only the first is a punishment. Every other one clears on its own, and the one
that bites hardest — the open ceiling — is handed straight back the moment a
moderator works the queue: report real cheaters and you get your allowance back
within the hour, report everybody you lose to and you run out by lunchtime. The
"crying wolf" lockout is counted from the last dismissal rather than stored, so
it expires with nothing to clean up. **ACCOUNT ▸ REPORTS** shows where you
stand against all of them.

**A moderator can switch reporting off for one account entirely.** The ceilings
above answer the ordinary failure, which is somebody reporting too eagerly; this
is the other case, an account using the queue as a weapon. It is its own sanction
rather than part of a ban or a mute — they keep playing and keep talking, they
simply cannot file — and the reason travels with it onto the greyed button they
find on their own scoreboard. Issue it from **PLAYERS ▸ REPORT BAN** in the admin
panel, or straight from the reporter's line at the bottom of any report in the
queue. It can be timed or indefinite, and a timed one lifts itself.

**You hear back.** The report lands in the admin panel's *Reports* tab, where a
moderator settles it as **action taken** or **no action** and writes one line for
the reporter. That line — and nothing else; never who settled it, never the
length of the sanction — comes back under **ACCOUNT ▸ REPORTS** in the menu,
where every report you have filed is listed with its verdict. A report that
disappears into a queue and is never spoken of again is a report nobody files
twice.

### Profile pictures

An account can upload a picture from **ACCOUNT ▸ PROFILE**. It is drawn round
everywhere it appears — the header chip, the account panel, the leaderboard —
and cropped from the centre, so the corners were never going to be visible.

The storage policy is the point of the whole feature:

* **The browser does the work.** The picked file is centre-cropped to a square,
  scaled to **256×256** and re-encoded as WebP (JPEG, then PNG, as fallbacks)
  before anything is uploaded. Whatever came off a phone camera leaves as a
  thumbnail of roughly 20 KB.
* **The server does not believe it.** The declared content type is a hint; the
  magic bytes are the fact. Every upload is sniffed and *measured from its own
  header* — PNG, JPEG and WebP only — and refused past **192 KB** or **512×512**.
  A 900×900 PNG of one flat colour compresses to nothing, which is exactly why
  the dimension check exists alongside the byte one.
* **One file per account.** The name is `<userId>-<content hash>.<ext>`, so a new
  picture is a new URL: a browser can cache one for a year and still never see a
  stale avatar. Uploading replaces, deleting removes, and deleting the account
  takes the file with it.
* **Served as what it is.** Files live under `data/avatars/` with the database,
  never in the client root. `/avatars/<file>` matches a strict pattern before it
  reaches the filesystem, and the content type comes from that name rather than
  from anything the uploader said, with `nosniff` on top.

A moderator can take a picture away from the admin panel without banning
anybody — most of the time the picture is the entire problem, and it is the one
piece of user content a mute does not reach.

### Clans

A clan is a **tag of two to four characters** drawn in front of your nickname
everywhere one appears — the scoreboard, the chat, the killfeed, the leaderboard
and the nametag over your head out in the world. It reads **grey** normally and
**gold** once the developers have verified the clan; that colour is the entirety
of what verification buys, which is exactly why it can be given on judgement
rather than through a process.

Everything lives under **CLANS** in the menu.

| | Requirement |
| --- | --- |
| Join one | level **5** (`CLAN_JOIN_LEVEL`) |
| Found one | level **15** (`CLAN_CREATE_LEVEL`) and **1000 GR** (`CLAN_CREATE_COST`) |
| Tag | 2–4 characters, `A–Z` and `0–9` only, unique, not reserved |
| Members | 24 (`CLAN_MAX_MEMBERS`) |

**The tag rules are narrow on purpose.** A tag that can hold a zero-width
joiner, a right-to-left mark, a combining accent or a bracket is a tag that can
impersonate a moderator, break a killfeed row or paint over the plate next to
it — and a scoreboard has no way to tell that apart from a clan name. So the tag
is plain uppercase ASCII, nothing else, and a short list (`MOD`, `DEV`, `ADMN`,
`STAF`, …) is reserved so no tag can read as something the server said.

**Clans are invite-only.** There is no "request to join", so a clan is never
something that happens to you and the owner is the only door. The owner can:

* **invite** anybody at level 5 or above who is in no other clan — the
  invitation shows up in their own CLANS panel and lapses after 72 hours;
* **remove** any member;
* **hand the clan over** to a member, staying on as a plain member themselves;
* **set a clan picture**, cropped and shrunk in the browser exactly like a
  profile picture and measured by the server exactly as strictly;
* **disband** it, which strips the tag from everyone at once.

An owner cannot simply walk out: they hand it over or disband it, because a clan
with nobody who can invite, remove or disband is a clan nobody can fix. One
player is in **one** clan — enforced by a unique index, not a check, so two
invitations accepted in the same second cannot both win.

Membership changes reach a match already in progress: joining, leaving, being
removed or having the clan verified re-badges every live connection on the spot
rather than waiting for a reconnect.

### Creator status

**The one thing in this game a human decides.** Everything else here is a number
that goes up on its own: levels, GR, mastery, a day streak. Creator status is not
earned by playing at all — you say what you make, link to it, and somebody reads
it. That is what makes it worth having.

Apply under **CREATOR** from level 5 (`CREATORS_MIN_LEVEL`, and a confirmed email
address where the server sends them). Four disciplines, and each one's perk is
built out of what that discipline actually produces rather than being a badge in
a different colour:

| Discipline | What it earns |
| --- | --- |
| **Music** | A [player anthem](#player-anthems): up to ten seconds of your own music, played over the kill cam of everyone you kill, credited by name |
| **Art** | Commission your own weapon finish — brief it, pick the palette, link the reference, and it goes into a queue a person reads and answers. Plus the engraved card frame, which is not for sale |
| **Video** | The director's cut kill cam: thirty seconds instead of ten, letterboxed and interface-free — the replay for as far back as the ring goes, then the orbit for the rest. Plus a clean-screen key that strips the HUD for a shot without touching settings |
| **Code** | [Developer mode](#developer-mode) with no level gate, and the three instruments the gate does not open — the wire inspector, the reconciliation trace and the frame-time histogram |

All four wear a badge beside their name wherever one is drawn, and all four get
links on their profile card.

**A pending application grants nothing.** The status is checked inside the single
gate every route asks — `creatorCan()` in `shared/constants.js` — rather than by
each route in turn, so "approved" is a thing that cannot be forgotten in one
place. Nor can a discipline reach past its own grants: a musician cannot file a
skin brief and an artist cannot upload an anthem, whatever the request looks
like.

Applications are read in the admin panel under **CREATORS**, which shows the
pitch, the links, the account behind it — including any reports filed against
them — and plays the anthem back before anybody decides to keep it. Approving,
rejecting and revoking all write to the audit log, and a revocation deletes the
anthem file with it: a perk that outlives the status it came from is a perk
nobody took away.

Stepping down is one button under **CREATOR**, and it goes through the same path
a moderator's decision does, so the history says what happened.

**`CREATORS_ENABLED=false` closes the whole thing, everywhere.** The routes
refuse, the queue stops, the rail entry disappears from the menu and the page
behind it says so instead of offering a sign-in — an interface that advertises
something the server does not do is worse than no interface. Anything already
approved keeps working, and an anthem already on disk still plays; nothing new is
taken and nothing new is granted.

#### Links on a card

Creators can put up to five links on their profile — YouTube, Twitch, Kick, X,
Bluesky, Instagram, TikTok, SoundCloud, Bandcamp, Spotify, GitHub, ArtStation,
itch.io, Ko-fi, or their own site.

**You give a handle, not an address.** The URL is built by the server out of a
platform id and a handle that had to match that platform's own character rules to
be stored at all, so nothing anybody types ever becomes a scheme, a host, a port,
a query or a fragment on somebody else's screen. The card shows the *handle*
rather than the address, so a label can never disagree with where it goes, and
clicking one names the host it is about to open before it opens it.

The one free field is a personal site, and it is a bare hostname: https only, no
path, no port, no userinfo, no punycode (which is how a domain reads as somebody
else's), and a real alphabetic TLD — which incidentally refuses a bare IP.

#### Player anthems

Ten seconds of a music creator's own work, played to whoever they just killed.

**Loudness is not something the uploader decides.** That is the whole design.
Somebody will upload a scream, so the rule is not "refuse loud files" — it is
that there is no such thing as a loud file. The server measures every upload over
its loudest 400 ms and rewrites the samples to a fixed level before a byte is
stored, so a brickwalled wall of distortion comes out about 19 dB quieter than it
went in and a quiet piano comes out louder. The old trick of nine seconds of
silence with an air horn on the end does not work either: measured over a short
window, it is an air horn.

Three more things sit under that, in order:

* The file is **re-emitted**, not patched — a canonical 44-byte header and
  samples, so any other chunk the container was carrying is gone rather than
  stored and later served.
* Both ends are ramped, because a ten-second cut out of the middle of a track
  starts on whatever sample it landed on, and a discontinuity into somebody's
  speakers is a click at full scale.
* The client plays every anthem through **its own limited channel** at the
  listener's own volume (**SETTINGS ▸ AUDIO ▸ Player anthems**), so a file that
  somehow got past the first rule still cannot get past the second. Turn it to
  nothing and the cam simply runs silent.

Stored files are served from `/avatars/anthems/<file>` — under the *pictures*
prefix rather than one of their own, because the nginx vhost proxies all of
`/avatars/` and stops before its regex locations, so a new kind of user content
under there needs no change to the web server. A prefix of its own would 404 on
every deployment whose nginx config had not been reinstalled. The path reads
oddly for a sound file; a silent 404 on somebody else's server reads worse.

The format is deliberately the dullest there is: mono 16-bit PCM at 32 kHz, in a
plain RIFF wrapper. Not because that is a nice format — it is enormous — but
because it is the only one a server with no audio library can *measure*, and a
loudness rule that cannot be checked is not a rule. The browser has a full
decoder built into it, so the uploader takes whatever you have, lets you pick
which ten seconds to use, and encodes what the server can read. See
`server/util/audio.js`.

### Developer mode

**Instruments, not powers.** Unlocked at level 10 (`DEV_MODE_LEVEL`), or at any
level with code creator status. A stack of read-only overlays down the side of
the screen while you play, each switched on separately under **DEVELOPER**:

| Panel | What it reads |
| --- | --- |
| **Performance** | Frame time at p50 and p99, draw calls, triangles, geometries, textures, programs, JS heap |
| **Network** | Round trip, jitter, up and down byte rates, packet counts, how deep the snapshot buffer is, the interpolation delay, the clock offset, inputs still queued |
| **Player state** | Your position, velocity, speed, whether you are on the ground, the surface under you, crouching, sliding, yaw and pitch |
| **Render toggles** | Wireframe, post-processing off, the map's collision volumes, a frozen frustum |
| **Wire inspector** *(code creator)* | Every opcode the socket carries, counted and sized, newest first |
| **Reconciliation** *(code creator)* | Your own prediction against the server's correction, as a trace — median, p99 and the shape |
| **Frame histogram** *(code creator)* | Where the long frames are, as a distribution rather than an average |

**Nothing here shows you one fact about another player that your screen was not
already about to show you.** That is the entire design constraint, and it is why
there is no enemy hitbox overlay: "draw a box around every player" is a debugging
tool right up until the boxes are visible through a wall, at which point it is a
wallhack that shipped with the game. So the reconciliation trace is of *your own*
body and the collision overlay is of the *map* — static data every client
downloaded before the match started. The wire inspector counts opcodes and bytes
and never draws what is inside one.

The overlays redraw eight times a second rather than per frame, and every number
in them is a counter something else was already keeping. With the mode off, the
samplers return on their first line.

Bind a key to it under **CONTROLS ▸ Developer overlays** — there is no default,
because a key an unlocked feature does not use is a key it should not be holding.

### Clicking a name

**Every nickname in the game is a link to that player's profile** — on the
scoreboard, in the chat, on the end-of-match card, on the leaderboard and in a
clan roster. It opens the same card everywhere. Guests and bots have no profile
behind them, so neither gets a link that could only ever fail.

The card reads **across**, not down: a hero band with the picture, the name, the
clan tag and the level bar on the left and three pinned figures on the right,
then the career in one column and the last six matches in the other. Below 900px
wide it folds back into a single column.

**The card is painted in its owner's colour.** By default that colour is pulled
out of their profile picture — the picture is shrunk to a thumbnail, its pixels
are dropped into hue/saturation/lightness buckets, and the bucket that scores
highest on *coverage × colourfulness* wins. Averaging the pixels instead gives
you brown every time, because the mean of a colour wheel is grey. An account
with no picture falls back to a colour derived from the nickname, so every card
has one and the same account always has the same one.

From the card you can **add them as a friend**, **cancel** an ask already in
flight, **accept** or **decline** one of theirs, **drop into their match**, or —
on your own — open the editor. Every one of those buttons is drawn from what the
*server* said is possible for this viewer rather than from what the browser can
guess: a button the route would refuse is worse than no button, because it
teaches people that the card lies.

#### Customising it

**ACCOUNT ▸ CARD.** Colour (from your picture, or one you pick), one of twelve
backdrops at three strengths, a frame for the picture, one of three layouts, a
tagline and a short about, and which three statistics get the big band beside
your name. The preview beside the controls is the *real* card renderer at a
smaller size, not an approximation of it, and nothing is sent until you press
SAVE — so trying eight backdrops costs eight repaints and no requests.

Every catalogue is in `shared/constants.js` and the save route runs
`normaliseCard()` before it writes, so a value the server does not recognise
becomes the default rather than a 400 that loses the rest of the edit. A card is
drawn inside other people's screens; "any string the browser felt like sending"
is a styling hole with an audience.

This is also why the scoreboard key **pins the board open and hands the mouse
back** rather than showing it only while held — the same gesture that makes the
mute and report buttons clickable at all.

### Scoring, XP and GR

Points are what the match is played for, and they buy two things when it ends:
**every 100 points becomes 1 GR** (plus 25 GR for the win), and **every point
becomes 1 XP.** Finish a match on 3204 points and you are 3204 XP and 32 GR
better off. The live board in the top-right corner shows nickname and score;
`Tab` opens the full card.

XP used to be its own formula — so much per kill, a bonus per headshot, a lump
for the win — which meant the number on the end card had no relationship to the
one the player had been watching climb all match. The scoring table below already
prices every one of those things, and prices them against each other; paying the
score back as XP is that judgement applied once instead of twice.

| Event | Points | |
| --- | ---: | --- |
| Kill | 50 | every elimination |
| Headshot | +50 | on top of the kill |
| Midair | +25 | the victim was airborne |
| Airshot | +25 | *you* were airborne |
| Drift kill | +50 | killed while sliding |
| No scope | +100 | sniper kill without scoping |
| Quickscope | +60 | sniper kill within 0.35 s of scoping in |
| Longshot | +50 | over 60 units |
| Backstab | +75 | knife from behind |
| Multi kill | +40 | a second kill within 4.5 s |
| Killstreak | +25 | at each streak milestone |
| Assist | +25 | you damaged the victim |
| First blood | +50 | the match's first kill |
| Revenge / Shutdown | +25 / +40 | payback, or ending a 5+ streak |
| **Nuke** | **+500** | you called one in and it landed |
| Suicide / team kill | −25 / −50 | |

Your score survives a class change, and survives leaving the match: rejoin the
same room before the clock runs out and the scorecard comes back with you.

**A blank scoreboard pays nothing.** Finish a match on 0 points and you earn
0 GR — the win bonus included. Standing in a spawn while the team carries the
round is not work, and it used to pay 25 GR.

Daily challenges pay their own XP and GR on top, and the end-of-match card lists
them separately.

### The nuke

**Twelve kills without dying arms it.** A prompt comes up, and pressing `N` (or
`L3`) spends the streak: the whole room is told at once and given **seven
seconds** to come and find you. Survive them and everybody on the other side
dies where they stand — everyone else in a free-for-all, the other team in a
team mode — you are paid 500 points, and the match ends on the flash.

Killing the caller calls it off, and that is the only counterplay there is,
which is exactly why it is announced rather than simply happening. So do leaving
the match, or switching yourself into spectator mode: the launch belongs to a
body standing in the world, and it goes wherever that body goes.

Everything about it is the room's: the arming test, the countdown, who dies and
whether the match ends. The client presses a key and draws a siren.

- **Earned, not automatic.** The moment a streak is worth something is the
  moment its owner decides to spend it. It also cannot end a match out from
  under the person who earned it.
- **One per run.** Launching resets the streak, so it is one nuke per life
  rather than one every twelfth kill.
- **One per room.** A second launch during a countdown would be two flashes and
  one match ending; the arming test refuses it.

### Daily streak and first win

Two bonuses ride on top of the match payout, both claimed on the **first match
you finish** each UTC day — not on signing in. That distinction is the design:
what they pay for is playing, so neither can be farmed by loading the menu, and
a player who came back and played one match has already earned the day.

| | Pays |
| --- | --- |
| **Play streak**, day 1 → 7 | 60 → 240 GR and three times that in XP, climbing 30 GR a day |
| **First win of the day** | 140 GR and 400 XP, flat |

Past day seven the run keeps counting but the payout stops climbing, and a day
missed resets it to one. A curve that kept climbing forever would turn one
missed evening into a reason to stop playing altogether; a flat one would give
nobody a reason to come back on day three. Both bonuses are drawn on the
**PROGRESSION** tab of your account panel, and both are announced on the
end-of-match card as their own lines rather than quietly inflating the match
figure.

**And the card says what tomorrow is worth.** The streak panel has always known
the next day's figure; nothing ever said it at the moment somebody is deciding
whether to play one more or close the tab. It is drawn at the far end of the
rewards strip, in the quiet register — everything to its left was earned, and an
offer that looked like a payout would be selling.

### Challenges: tonight, this week, and this career

Three lists, on three timescales, because "a reason to play" means a different
thing on each one. All three live on the **CHALLENGES** tab and all three are
paid automatically at the end of the match that completes them.

| | How many | Resets | Worth |
| --- | --- | --- | --- |
| **Daily** | 3 | Every UTC midnight | 300–800 XP, 25–70 GR each |
| **Weekly** | 3 | Monday morning | 3 500–9 000 XP, 280–700 GR each |
| **Career milestones** | 21 | Never | 500–55 000 XP, 80–5 000 GR each |

Everybody is given the same three of each, picked deterministically from the day
or the week number — so a challenge is something to talk about rather than
something you were unlucky with.

**A daily is worth one evening and is gone by morning, whether or not it was
finished.** That makes it useless to somebody who plays twice a week: the target
resets before they can reach it, so there is never anything to come back *to*.
Weekly goals are deliberately out of reach of a single sitting — a week's worth
of them is what a Tuesday session and a Saturday session add up to — and the
progress survives in between. Both kinds share one table, keyed by a period
number; a week's number is pushed above a million so the daily cleanup, which
deletes everything below the last few days, cannot sweep away a week that is
still running.

**Career milestones are the only list here that never resets.** Twenty-one
thresholds on lifetime counters that only ever go up — kills, wins, headshots,
matches finished, best killstreak, damage, hours played — each paid exactly once.
The list is deliberately front-loaded: the first rung of every track is inside a
first evening, so a new account collects two or three immediately and learns the
list is worth reading. The top rungs are years of play and are meant to be.

They are drawn closest-first rather than earned-first, and only the nearest one
is highlighted. A trophy cabinet gives nobody a reason to play tomorrow; the
*next* rung does, and a screen where everything is the next thing has no next
thing on it. When one lands it is named on the end-of-match card in gold, apart
from the dailies — a line somebody has been walking toward for a month should not
arrive looking like the third of tonight's three chores.

Each is claimed through a primary key rather than a check-then-write, so two
matches ending in the same instant cannot pay the same milestone twice.

### The progression ladder

Levels do not gate anything that decides a fight: all nine classes, every map and
every mode are yours from the first match. What a level buys is the parts of the
game that are about other people.

| Level | Unlocks |
| ---: | --- |
| 1 | Every class, every map, every mode. Skins, bought with GR |
| 2 | Writing in the match chat |
| 5 | The **REPORT** button, joining a clan, and applying for [creator status](#creator-status) |
| 10 | [Developer mode](#developer-mode) — the read-only overlays |
| 15 | The Veteran weapon finish, and founding a clan |

**ACCOUNT ▸ PROGRESSION** draws exactly that ladder with your own level on it,
what each rung unlocks and how much XP is left to the next one. Each of these
thresholds already existed; none of them was written down anywhere a player could
read *before* the level stopped them. Move one in `.env` and the panel moves with
it — the server hands the client its own numbers, so the ladder promises what
this server will really do.

Crossing a rung takes effect where you are standing: reach level 2 mid-session
and the chat unlocks in the same breath as the reward card, with no reload.

**Every level crossed pays GR on the spot**, and it pays more the higher up the
ladder it is — 124 GR at level 2, 566 at 15, capped at 1 800. It arrives as its
own line on the end-of-match card rather than folded into the match figure.

#### The curve, and why it bends where it does

Total XP to reach level *L* is

```
260 × (L − 1)^1.75        +        46 × (L − 10)^2.75   (only past level 10)
└─── the base curve ────┘          └───── the ramp ────┘
```

Two terms doing two jobs. The first is the whole curve up to level 10 and keeps
the bottom of the ladder reachable: level 2 is one short match, and the gates
that live down there — the chat at 2, the report button and a clan at 5 — are
still a first sitting away, because that is where people decide whether to come
back at all. Past 10 the second term takes over and grows much faster.

**The whole thing was lifted in 1.6, because it was being cleared far too fast.**
A match pays its score back as XP one for one, and a decent four-minute round is
a couple of thousand points — which put level 10 inside two matches and level 50
inside a hundred. A level nobody had to work for is a number, not an achievement.

| Level | 1.4 total | 1.6 total | | Matches, at ~1 800 XP each |
| ---: | ---: | ---: | --- | ---: |
| 10 | 3 616 | 12 158 | ×3.4 | ~7 |
| 15 | 7 763 | 30 190 | ×3.9 | ~17 |
| 30 | 43 899 | 268 242 | ×6.1 | ~150 |
| 50 | 181 705 | 1 406 586 | ×7.7 | ~780 |
| 100 | 1 233 344 | 11 695 271 | ×9.5 | ~6 500 |

Note what did *not* change: matches still pay exactly the score you watched climb
all round. Levels got dearer rather than matches getting stingier, because the
number on the end card has to keep meaning what the scoreboard said.

**Nobody lost a level they had already earned** — not in 1.4 and not in 1.6.
Levels are derived from XP rather than stored, so the first boot after a change
like this would quietly demote every account above the old curve, taking their
chat, their report button and their clan membership down with them. Instead
`regradeLevels()` tops those accounts up to exactly what their level now costs:
they keep the level, they keep a coherent XP figure behind it, and the new curve
applies to everything they earn from here. The marker it writes is the curve's
*generation* rather than a flag, so the pass runs again — once — the next time
the ladder is reshaped.

### Classes

| Class | Weapon | Damage | RPM | Mag | Speed |
| --- | --- | ---: | ---: | ---: | ---: |
| Triggerman | Assault Rifle | 28 | 600 | 30 | 1.00× |
| Hunter | Sniper Rifle | 100 | 52 | 5 | 0.86× |
| Run N Gun | SMG | 17 | 950 | 28 | 1.18× |
| Spray N Pray | LMG | 23 | 780 | 60 | 0.85× |
| Vince | Revolver | 56 | 210 | 6 | 1.08× |
| Detective | Akimbo Uzis | 14 | 1250 | 44 | 1.12× |
| Marksman | Marksman Rifle | 46 | 320 | 12 | 0.94× |
| Bulldog | Pump Shotgun | 13 × 9 | 78 | 6 | 1.02× |
| Rocketeer | Rocket Launcher | 130 + splash | 46 | 1 | 0.82× |

Every class also carries the **P9 sidearm** (25 damage, 330 rpm, 15 rounds) and a
combat knife (backstabs hit for 145). The pistol is deliberately kept a hair
under lethal at four rounds: 25 × 4 is exactly a full health bar, so a
point-blank four-tap kills and any distance at all makes it five. It is free, it
is on every class, and it must never be the reason a fight was won at range.

The sniper is the other weapon balanced on one number: **scoped it is perfect and
unscoped it is a lottery.** Its hip-fire cone is genuinely wild, because a rifle
that deletes anybody it touches has to be aimed to touch them.

The launcher is the one weapon with a **draw time of its own**. Bringing any
weapon up is recorded as a shot a moment ago, so what stands between the swap
and the first round is that weapon's fire interval — nothing at all on a rifle,
and a second and a third on a tube that fires 46 times a minute. `drawTime: 0.25`
in its definition caps that at a quarter of a second, which is about how long
the launcher takes to reach the shoulder. Its rate of fire is untouched: this
removes the wait for the *first* rocket, not the wait between two of them.

Headshots multiply damage by roughly 2.35×; leg shots reduce it. **Reserve ammo
is unlimited for every weapon in the game** — only the magazine and the reload
timer matter.

### Maps and modes

| Map | Character |
| --- | --- |
| **Littletown** | A suburban crossroads: fences, parked cars, rooftops and a plank run over the street |
| **Burgtown** | Cobbled market square under a clock tower, stalls and balconies |
| **Crossfire** | A half-built street on three levels — trench, yard, scaffold. Rotationally symmetric |
| **Sandstorm** | Whitewashed desert town around a dry fountain — built for team play |
| **Shipyard** | Painted container maze under a steel gantry, with the sea down one side |
| **Subzero** | An alpine village around a frozen pond. Short rotations, constant contact |
| **Nova** | A night station under a pink-and-blue nebula, on four floors — see below |

No map is walled in. The edge of the playable area is an invisible boundary, and
past it the level carries on in scenery you can see but never reach — which is
the whole reason a map can be dense with cover without feeling like a corridor.

Every solid in a map is an axis-aligned box, and each one is one of three
things: a **solid** (collides, renders, stops bullets), **decor** (renders only
— lawn trim, road paint, a window pane, the glass in a parked car) or a **clip**
(collides only — the boundary). Dressing therefore never takes a corner off a
gunfight and never eats a round.

The line between the first two is *what a player would expect*, not what is
cheap. Anything that reads as a mass is solid, whatever it costs the collision
world: tree canopies, hedges and bushes, benches, fence posts. Running through a
tree was the single loudest thing wrong with these maps, and a tree that stops
bullets is a tree that is cover — which is what everybody already believed it
was. Only genuinely flat or genuinely overhead dressing stays decor.

**Nova** is the largest map in the game and the first one built as a stack
rather than a plan. Four floors, all of them walkable, all of them reachable
from each other without a lift or a trick jump: the plaza at ground level, a
ring walkway around the reactor bay six metres up, the tower roofs and the
bridges joining them at thirteen, and one platform on top of the reactor spire
at twenty. The only way to that last one is the spiral — six flights wound one
and a half times around the spire, each facing a different quarter of the map —
so the best perch on the map costs eight seconds in the open, in view of four
towers, to reach. Nobody holds it for long, which is the point of putting it
there.

It is also the first night map, and it is lit differently on purpose: every
walkable edge glows and nothing else does. Cyan means structure you can stand
on, magenta means the reactor and the crown, and white means a spawn hall — so a
player who has lost their bearings finds the way back by looking for the one
colour that means back. The sky is not a painted dome like the others: two
fields of gas drift past each other, stars twinkle behind them and a meteor
crosses every few seconds, all of it derived from one clock so every screen in
the match is looking at the same sky.

Modes: **Free For All** (30 kills / 4 min), **Team Deathmatch**
(50 kills / 4 min) and **Perks** (30 kills / 4 min — see below), up to
**8 players** per room. When the clock runs out the
full scoreboard — score, GR earned, kills, deaths, assists, headshots, damage,
accuracy, best streak — stays on screen for the 18-second intermission, then the
room rotates to the next map.

Nametags and minimap blips only appear for enemies you can genuinely see: the
client line-of-sight-tests each one a few times a second and drops the plate the
moment they break line of sight (with a one-second fade on the minimap). Nothing
on the HUD tells you about someone behind a wall — with one deliberate
exception, and it belongs to a camera with no body in the match: a spectator can
turn x-ray on with `X`.

### Perks: choosing what kind of player you are

A mode where the body is the choice. Before the match starts you pick one of
seven, and every one of them is a trade — something you are better at than
anybody has ever been, paid for with something you are worse at than anybody
should accept.

| Perk | What you get | What it costs |
| --- | --- | --- |
| **Trooper** | Reloads a fifth faster, a tenth tighter cone | 5% less health |
| **Runner** | Bunny hops bleed no speed at all and top out 35% higher; faster on foot, jumps higher | **Half** the health of everybody else |
| **Juggernaut** | Nearly twice the health, takes 15% less damage | Noticeably slower, reloads slowly, jumps badly |
| **Marksman** | A third more damage, a little under half the spread | A quarter less health, slower on foot |
| **Medic** | Heals more than twice as fast and starts almost immediately | Deals under a fifth less damage |
| **Berserker** | 40% more damage, faster, takes no fall damage | Takes 40% more damage, **never regenerates** |
| **Scavenger** | Magazines hold three quarters again as many rounds; a kill reloads the gun outright | Deals a little less damage, 10% less health, reloads slowly |

There is deliberately no "balanced" option. A mode built on choices whose safe
answer is "don't choose" has no choices in it, so the mildest of the seven —
Trooper — is still a real pick rather than the absence of one.

The picker opens at the start of every match and on the class key (`B` by
default) at any time. Out of combat a swap lands immediately; mid-fight it waits
for your next respawn, the same rule a class change follows and for a sharper
reason — a perk changes how much health you have, and a swap under fire that
took effect at once would be a Runner topping up to a Juggernaut's ninety hit
points in the middle of losing a gunfight. The choice belongs to the *match*: a
new one asks again.

Everything a perk changes is decided by the server. Movement is the one part
that also runs on your machine, because prediction has to agree with authority —
the client is *told* which perk it has and builds the same numbers from it, and
never chooses for itself. Nothing about a perk is ever read out of a packet.

### The room list grows with the crowd

`ROOMS` is the **floor**, not the whole list: one room per flavour the server
advertises, so the browser is never blank and every mode is always playable.
Everything past it is opened and closed by demand.

A fixed room list is wrong in both directions at once. On a quiet Tuesday it
scatters four players across eight empty matches; on a busy evening it tells
everybody "every room is full" while the machine sits idle. So there is one rule
in each direction, and both are about **seats**:

| | Rule | Knob |
| --- | --- | --- |
| **Open** | A mode whose free seats have fallen to `ROOM_HEADROOM` or fewer is about to turn a duo away, so it gets another room — on a map that mode is not already playing | `ROOM_HEADROOM=2` |
| **Close** | A room past the floor that has been *completely* empty for `ROOM_IDLE_SEC` is costing a tick for nobody | `ROOM_IDLE_SEC=120` |
| **Ceiling** | Never more than this many rooms in total. About CPU, not seats: every room is simulated every tick | `ROOMS_MAX=32` |

Three details that are the difference between this working and flapping:

* **A mode nobody is playing never gets a room.** Free seats alone would open one
  for an empty server, close it two minutes later, and do it again forever.
* **The idle window is longer than a map rotation and longer than a reconnect,**
  because a room that vanishes between two matches is a shared link that stopped
  working.
* **Somebody who arrives one second before the balancer runs is not turned away.**
  `pickRoom` opens the room itself rather than waiting for the next housekeeping
  tick.
* **The practice range is one room, always.** Nobody who pressed QUICK MATCH
  asked for a shooting range, so it is skipped by matchmaking in both directions.

`DYNAMIC_ROOMS=false` pins the list to exactly `ROOMS`, forever.

#### A room nobody is in does not run

Every room starts **dormant** and stays that way until somebody walks in. A
dormant room is listed, joinable and shareable — it simply is not simulated: no
clock, no physics, no snapshots, no bots and no map rotation. The first person
through the door wakes it with a fresh match; the last one out puts it back to
sleep, abandoning whatever round was in progress.

This is not only about CPU, though eight idle tick loops is eight idle tick
loops. A running room *finishes matches*, and a finished match used to be written
to the database whether or not anybody had been in it — so a server that nobody
played on all night still produced fifteen match records an hour, and most of the
match history was rounds that never happened. **Nothing empty is recorded, paid
out or graphed.** The match row is now written at the *end* of a match rather
than the start, and only when at least one human was in it.

Two consequences worth knowing:

* **The room's clock is thrown away when it sleeps.** Handing an arrival forty
  seconds of a match nobody played is worse than handing them a fresh one, and a
  stale intermission would sit them in front of an end card for a round that
  never took place.
* **A spectator counts as somebody.** A watcher is a person looking at the arena,
  and an arena that stopped moving underneath them would be a bug rather than a
  saving.

The balancer also caps demand-opened rooms against the number of people actually
online rather than against `ROOMS_MAX`, so a brief rush cannot leave a quiet
server carrying a dozen rooms for the length of the idle window.

---

## Accounts, names and abuse

### Your name belongs to your account

A guest does not choose a nickname. The server assigns one (`Guest4417`) and
ignores whatever the client proposes, because a nickname is what the
leaderboard, the killfeed and a report all point at — if anyone can type one
in, anyone can wear somebody else's. Signing in is what buys the right to be
called something.

Changing it afterwards costs **100 GR** (`RENAME_COST`), from *Account →
NICKNAME*. Changing only the capitalisation of your own name is free: it
collides with nobody. The price is taken first and refunded if the name turns
out to have been bought a moment earlier by someone else — the unique index on
the name, not an earlier lookup, is what settles that race.

### What an account is worth, said out loud

The menu has had a **★ GET SIGNUP REWARDS** button since the first release, and
it opened a form that promised nothing. It now pays a real list, granted inside
the same transaction that makes the account — an account that exists without the
balance the screen just promised it would be a broken promise nobody would ever
notice was a bug rather than a lie.

| | |
| --- | --- |
| **500 GR** | Enough for a first weapon finish |
| **The Enlisted finish** | Earned, never sold. The one skin a guest can look at and own five seconds later |
| **Your name, kept** | A guest is assigned one and loses it every session |
| **XP and levels** | Every point you score becomes XP the moment a match ends |
| **Daily streak & first win** | Two bonuses a guest can never claim |

The list is drawn from `SIGNUP_REWARD` in `shared/constants.js`, which is also
what the server grants from — so the card on screen cannot advertise a number the
account does not receive. Accounts that predate the feature were granted the
finish by the migration: they made an account, which is the whole condition.

**And a guest who finishes a match is shown what it would have been worth.** The
end-of-match card puts the real figure in front of them — the same two functions
that pay an account, applied to the score they just watched climb — rather than a
slogan:

> **3 204 XP · 32 GR** is what those 3 204 points were worth — and a guest keeps
> none of it.

Nothing is stored against it. There is no account to store it against, and
pretending otherwise is a lie the next session exposes.

### Two-factor authentication

A password is one secret, and a secret that has been reused anywhere else is a
secret somebody else already has. **ACCOUNT ▸ SECURITY** turns on a second one:
scan the QR code with any authenticator app — Google Authenticator, Aegis,
1Password, whatever — and signing in asks for six digits as well as the password.

It is RFC 6238 to the letter (SHA-1, six digits, thirty-second steps, ±1 step of
clock tolerance), which is what makes every app on the planet agree with it, and
the published test vectors are in the test suite.

**The QR code is drawn on your own machine.** `client/js/qr.js` is a complete
ISO/IEC 18004 encoder — Reed–Solomon over GF(256) and all eight mask patterns,
about three hundred lines — for exactly one reason: asking a chart API for a
picture of your `otpauth://` URI would hand that server your secret, and asking
somebody to retype thirty-two base32 characters into a phone is how a security
feature ends up switched off. The key is also shown as text, for a password
manager on the same machine or a phone with no camera.

Four rules the implementation is built around:

* **The secret only becomes real once a code from it has been checked.** Opening
  the setup card and wandering off leaves the account exactly as it was, rather
  than locked behind a secret nobody finished scanning. Until then the server has
  not stored it — the copy the client sends back at the confirm step is the only
  one that exists.
* **A code cannot be used twice.** Bare TOTP lets the same six digits be replayed
  for the whole thirty seconds they are valid, which is thirty seconds an
  attacker with a shoulder-surfed code does not have to hurry in. Each account
  records the last time step it accepted and only ever takes a strictly newer
  one, so a replay loses to its own first use.
* **Ten recovery codes, each good once**, for the day the phone is gone. They are
  shown exactly once and stored only as SHA-256 hashes, the same treatment
  session tokens get: a leak of the table is not a way into anybody's account.
  Regenerating them invalidates the whole previous set immediately.
* **An account with 2FA is indistinguishable from one without it until the
  password is already right.** The `totp_required` answer comes *after* the
  password check, so this route cannot be used to find out which accounts are
  worth attacking. It carries no token and no session — it is a second question,
  not a partial login.

Turning it off, and issuing new recovery codes, both cost the password *and* a
live code. So does changing the password, because a password change signs every
device out — which makes it the one move that turns a borrowed session into a
stolen account.

### Anti-bot: Cloudflare Turnstile

Sign-up and sign-in each carry their own Turnstile widget, with their own key
pair, so rotating one never disturbs the other. Only the **site** keys reach
the browser (through `/meta`); the secrets stay on the server and are what
actually enforce the check. A form whose secret is empty is simply not
challenged, which is how the server runs on a LAN or under test.

If Cloudflare cannot be reached, the check **fails shut** — a widget that waves
people through whenever a third party is down is decorative.

### Email verification

Sign-up asks for an address (`EMAIL_REQUIRED`) and mails a confirmation link,
valid for 48 hours and good for exactly one use. An unconfirmed account can
sign in, look around, correct its address and ask for another link — it simply
cannot take a seat in a match (`EMAIL_VERIFY_ENFORCE`).

Sending needs SMTP credentials, and the domain here receives its mail through
Proton, which does not hand those out on a personal plan. **[docs/EMAIL.md](docs/EMAIL.md)**
works through the three ways to get them and the exact Cloudflare records each
one needs. Until one is set up, `MAIL_TRANSPORT=log` writes the link to the
server log instead of sending it:

```bash
npm run mail:test -- you@example.com     # try the current settings
journalctl -u open-grunker | grep mail:log
```

Accounts that predate this feature were grandfathered in by the migration: they
had an address, and they signed up under rules that never asked them for one.

### No VPNs, proxies or datacenters

Every connection's address is classified before it is seated, and again on the
account routes so a blocked player finds out at the sign-in form rather than
after filling one in. Two providers:

| `VPN_PROVIDER` | Key | Notes |
| --- | --- | --- |
| `ipapi` *(default)* | none | ip-api.com — 45 lookups/min, HTTP only on the free tier |
| `proxycheck` | `PROXYCHECK_KEY` | proxycheck.io — HTTPS, far better on residential proxies |
| `none` | — | turns lookups off entirely |

Verdicts are cached in SQLite and in memory for `VPN_CACHE_HOURS`, so a player
reconnecting between matches costs nothing. Private and LAN addresses are never
checked. A lookup that *fails* decides nothing by default (`VPN_FAIL_OPEN`):
an unreachable third party is not evidence of cheating. Put your own address or
a friend's VPS in `VPN_ALLOWLIST` (bare addresses or CIDRs) to exempt it.

If legitimate players get caught, `VPN_BLOCK_HOSTING=false` is the knob to
relax first — datacenter ranges are where cheap VPNs live, but a few corporate
networks share them.

> **`CF_PROXY` matters here, in both directions.**
>
> `grunker.g0x.dev` resolves to Cloudflare, so the game is served through their
> proxy and `CF_PROXY=true`. Leave it off on a proxied site and every request
> looks like it comes from a Cloudflare edge address — which *is* a datacenter
> range, so the check would refuse every player on earth.
>
> Turn it on for a site that is **not** proxied and the opposite happens:
> `CF-Connecting-IP` becomes a header anybody can send, and bans, rate limits
> and this check all key on an address of the client's choosing.
>
> With it on, close the back door too: an attacker who learns the origin's
> address can reach nginx directly and forge the header. Restrict port 443 to
> [Cloudflare's published ranges](https://www.cloudflare.com/ips/) — a firewall
> rule, or `allow`/`deny` in the vhost.

### One player, one game

An account is in one match at a time. The default policy, `takeover`, gives the
seat to the newest connection and tells the older one why it lost it — the only
policy a half-open socket left by a browser crash cannot lock somebody out of.
`SINGLE_SESSION_POLICY=refuse` turns the second connection away instead, and
only when the first is actually playing: the menu keeps a spectating socket
open to render its backdrop, and pressing PLAY reconnects.

The client shows each of these refusals on its own screen, with the action that
resolves it — *I turned it off*, *send a new link*, *play here instead*.

### The anti-cheat

The netcode was written on one rule and, for a long time, never checked it: **a
packet may describe what a player did, never what the world is.** Everything a
client used to be able to simply assert about itself is now decided from state
the server built. `server/game/anticheat.js` is the bookkeeping; the refusals
themselves live in the room, next to the thing they refuse.

| What a client used to claim | What decides it now |
| --- | --- |
| The angles a shot was fired at | The view that same client has been streaming, within a tolerance that opens with its own measured turn rate |
| Which spread seed the round uses | The server's own shot counter, incremented per shot |
| Whether it was aiming down sights | The ADS bit of the freshest input received — the one the trigger was pulled under, which for a quickscope is not yet the one the tick has spent |
| Its round-trip time, which sets the lag-comp rewind | A round trip the server timed itself: the PONG carries a token, the client answers it in its own frame the moment it lands, and the gap between the two is the measurement |
| How many simulation steps it is owed | A budget that refills at the tick rate, with a burst for catching up after a stall |

Two properties matter more than the list.

**A refused packet is played, not dropped.** Every check hands back the
authoritative value, so a caught shot still fires — down the barrel the shooter
was really pointing. That is what makes a cheat *useless* rather than merely
detected, and it is also the only behaviour that is safe when the check is
wrong: a false positive costs a player nothing they would notice, where one that
silently ate their bullets would be indistinguishable from a broken server.

**Nothing is decided by a machine alone.** Refusals are scored, the score decays
in real time so an evening of jitter never accumulates, and crossing the kick
threshold drops the connection *and files a report* — into the same queue the
scoreboard's report button writes to, read by a person before anything happens
to an account. `ANTICHEAT_KICK=false` keeps the refusals and the reports without
the kick.

That report is written as a page rather than as a log line, because the person
working the queue at two in the morning has not read `anticheat.js` and should
not have to. It names in plain words what was refused, what a cheat doing it
would have been buying, when it started and when it stopped, the first *and*
last piece of evidence for each kind — a client that was 8° off once and 174°
off a minute later is a cheat somebody switched on mid-match; one that was 8°
off every single time is a connection — and, next to all of it, the worst ping
and jitter the server measured while it was happening. It also says, per kind,
whether a bad line can produce that kind at all, which is the question that
settles most of these reports.

**A bad connection is not cheating.** Four of the seven checks read what a
packet *contains* and cannot be produced by a bad line at all. The other three —
the latency claim, the packet rate and the input backlog — read when packets
*arrive*, and arrival times on a lossy connection are not a measurement of the
client: TCP holds a stalled stream and then delivers the whole backlog in one
frame, which looks exactly like a burst-fire speed hack for as long as you only
look at one second of it. So all three judge the *sustained rate* rather than
the burst, the burst itself is explicitly forgiven, and all three are weighted
below the decay rate — one a second is a connection the server sheds faster than
it accumulates.

The latency check in particular used to be the worst offender in the game. It
ran on both halves of every heartbeat, so a connection whose two medians merely
*disagreed* was flagged twice a second: a warning in under three seconds and a
kick in eight, for a player who had done nothing but ride a train through a
tunnel. It now runs once per measured round trip, widens its tolerance by the
line's own measured jitter, and only counts a disagreement that is sustained and
one-directional for a dozen samples running — because jitter alternates and a
made-up constant does not.

The aim check had a quieter version of the same problem. Its tolerance opened
with how stale the streamed view was *on the server*, which on an ordered socket
is almost always zero — so the allowance for a fast mouse was being multiplied
by nothing. What actually varies is on the other end: the view rides a
simulation tick and the trigger is pulled on a frame, so above 60 fps there are
frames with no tick in them and the crosshair has moved through all of them. The
gate accounts for that now, and for ping and jitter on top, which is what
stopped a hard flick at 144 fps reading as silent aim.

Every check is measured against something the *client itself* said earlier, never
against the server's own bookkeeping — and the difference is not academic. The
room counts the rounds it accepts; a client counts the rounds it fires, and the
room declines plenty of them (a shot a hair inside the fire-rate window, one
fired into a magazine the server had already emptied, one that landed during a
reload). An early version compared the two and so flagged every round anybody
fired after the first divergence: holding the trigger reached the kick threshold
in about two seconds. `tests/anticheat.test.mjs` plays all nine classes at four
frame rates with the client's own frame ordering for exactly this reason, and it
is the half of the suite that has caught things.

There is one residue worth naming rather than hiding: with the shot counter
taken away from the client, a determined grinder can still *burn* rounds to skip
a seed it does not like. It cannot hide from the average — the draw in
`shared/shot.js` puts a round 0.78 of the cone half-angle from point of aim, a
seed search puts it at 0.04, and forty rounds of that is eight standard errors
from honest. That gap is what `trackSpread` watches.

### Away from keyboard

Being away is **no key held and no view movement** — not a socket that has gone
quiet. A page left open on a match still streams sixty inputs a second and
answers every heartbeat, which is exactly what an anti-AFK script sends, and
under the old rule an empty body kept its seat and kept feeding the other team
kills for as long as the browser stayed open.

At `AFK_WARN_SEC` (75) a notice goes up and the automatic respawn stops: a dead
idle body is not put back into the match by the server or by the client. At
`AFK_KICK_SEC` (105) the seat goes back and the player lands in the menu. The
frame that says so is a courtesy — the socket is closed behind it either way, so
a client that ignored it ends up in the same place a second later.

Spectators are exempt on purpose: watching the map from the menu is what the
menu's backdrop *is*, and sitting still in it is not idling.

### Friends

A list of names is an address book; the presence on it is the product. `GET
/friends` answers with the list, both request queues and where everybody is this
second, so the panel can put a **JOIN** button on the row of anybody in a room
that has space, and sort the people who can be joined to the top.

A friendship has no direction, so it is one row with the two ids sorted — there
is no state in which A has B and B does not have A. A *request* does have one,
so it gets a row per direction; accepting deletes both and writes the pair, and
two people who happen to ask each other at the same time simply end up friends
rather than each waiting on the other. Declining tells the asker nothing, which
is what keeps declining a thing people are willing to do.

Every ceiling (`FRIENDS_MAX`, `FRIEND_REQUESTS_MAX`,
`FRIEND_REQUESTS_INBOX_MAX`, `FRIEND_REQUEST_COOLDOWN_SEC`, `FRIEND_MIN_LEVEL`)
answers one way of turning the button into a megaphone.

### Your card, and who it is for

**ACCOUNT ▸ PRIVACY.** Eight switches, each with three answers — *everyone*,
*friends only*, *no one* — plus one for the leaderboard:

| Switch | What it decides |
| --- | --- |
| Who can add me | Anyone · friends of friends · no one |
| Show when I am online | Whether your card says you are in the menu or in a match |
| Let people join my match | Whether your card offers a JOIN button while you play |
| Show my career stats | Kills, K/D, accuracy, damage, playtime |
| Show my recent matches | The last few games on your card |
| Show my day streak | How many days in a row you have played |
| Show my clan | The tag beside your name stays either way — this is the card |
| Show when I joined | The date the account was created |
| Show me on the leaderboard | Off takes your name off the public board; your stats still count |

Every one of them is enforced on the **server**. A section a viewer may not see
is left out of the response entirely rather than sent with a flag the client is
trusted to honour, so there is nothing in the payload for a modified client to
un-hide. What *is* sent is a short `hidden` list naming the sections that were
withheld, because "they have not shared their stats" and "they have no stats"
are different things and a card that cannot tell them apart reads as broken.

Two details worth knowing:

- **"Friends only" means people already on your list** — not people who have
  asked. Somebody with a request in flight gets the stranger's answer.
- **Closing the door does not trap a request already inside it.** An account set
  to *no one* can still accept an ask that was filed before the switch moved, and
  can still be asked by somebody it asked first.

A refusal is deliberately the same sentence for *no one* and for *friends of
friends*: which of the two it is, is a fact about an account that asked not to be
read.

### Your address is not on your stream

The account panel is what is open while somebody picks a class or reads their
stats, which is precisely when a screen is most likely to be shared. The email
address on it is masked — first character of each side and the top-level domain,
with a run of bullets that is not the length of what it hides — and **SHOW** puts
the real one back for ten seconds before hiding it again. Nothing about that
choice is remembered into the next session.

---

## Architecture

```
open-grunker/
├── shared/          Code loaded byte-identically by client AND server
│   ├── constants.js   tuning, enums, wire opcodes
│   ├── movement.js    the movement step (prediction == authority)
│   ├── physics.js     AABB world, broad-phase grid, raycasts
│   ├── weapons.js     nine classes, procedural weapon models, finishes
│   ├── maps.js        map data built from a small box DSL
│   └── shot.js        deterministic spread (seeded per shot)
├── server/
│   ├── index.js       HTTP + WebSocket + static + the admin listener
│   ├── config.js      env-driven configuration
│   ├── api/           REST router, /api/v1 endpoints, admin API
│   ├── game/          room, player, bot AI, hub loop, anticheat.js
│   ├── db/            SQLite schema, migrations and access layer
│   └── util/          auth, http, logging, rate limiting, static files,
│                      image sniffing and avatar storage
├── client/
│   ├── index.html     shell + HUD markup
│   ├── css/           the entire interface
│   ├── js/            renderer, netcode, HUD, menus, keybinds, audio,
│   │                  gunskin.js (weapon finishes), viewmodel.js (hands)
│   ├── admin/         the admin panel (served on the admin port only)
│   ├── vendor/        three.js (copied by `npm run vendor`)
│   └── dist/          the build (`npm run build`) — what production serves
├── vite.config.js     both builds: the game, and the panel under /admin/
├── deploy/            nginx vhost, systemd unit
├── scripts/           setup, deployment, database CLI
└── data/              SQLite database, avatars/ and clans/ (created on first run)
```

### Identifiers

Every entity in the database — account, clan, match, match row, report — is keyed
by a **UUID** held as TEXT, not by an autoincrementing counter. A counter leaks
how many accounts exist and in what order they signed up, collides the moment
two instances' data are ever put side by side, and invites anything downstream
to guess the next one.

A database created before this was true is converted **in place on first boot**:
`migrateToUuids()` in `server/db/index.js` takes a `VACUUM INTO` snapshot next
to the database file, mints a UUID per existing row, rewrites every foreign key
to match, and renames the picture files whose names carry an owner id. Sessions
survive it, so nobody is signed out. The one deliberate exception is
`admin_log`, an append-only journal read newest-first by its own counter, which
names nothing outside itself.

The per-match entity id a player carries in a snapshot is *not* one of these. It
is a small integer that lives for one match, is never stored and is never shown
— thirty snapshots a second is the wrong place to spend thirty-six bytes a
reference.

### Netcode

The server is authoritative and simulates at **60 Hz**, broadcasting snapshots at
**30 Hz**. Three things make it feel local:

1. **Client-side prediction.** The client runs the *same* `shared/movement.js`
   step on its own input immediately, then replays any un-acknowledged inputs on
   top of each snapshot. Because both sides execute identical code on identical
   input, the correction is normally exactly zero — measured median error is
   0.000 units, p99 is 1 cm.

2. **Entity interpolation.** Remote players are rendered 100 ms behind the server
   clock, interpolated between the two bracketing snapshots, so packet jitter
   never shows as stutter.

3. **Lag compensation.** When you fire, the server rewinds every other player to
   where *your screen* had them (`RTT/2 + 100 ms`, capped at 300 ms) and traces
   the shot against those rewound hitboxes. Measured drift between what the
   client draws and what the server rewinds to is 4 mm on average.

Bullet spread is **deterministic**: both sides derive pellet directions from a
seed seeded by `(playerId, shotSequence)`, so the tracer you see is exactly the
ray the server tested. Nothing about spread is trusted to the client.

### Where the frame goes

The rule for every one of these is that the picture does not change. Nothing was
turned down, no draw distance was shortened, no effect was cut: each is work the
game was doing that produced no pixels, or produced the same pixels twice.

**On the client**

| Was | Is |
| --- | --- |
| The minimap walked the level's whole box list every frame — a dressed town is well over a thousand `fillRect` calls, sixty times a second, for a picture that only rotates and slides | The walls are baked once per map into an offscreen canvas. Afterwards the minimap costs one `drawImage`, and the bake happens again only if the zoom slider moves |
| The HUD wrote about thirty DOM properties per frame — a `style.width`, a `textContent`, a dozen `classList.toggle`s — whether or not anything had changed. Every one invalidates style for its element | Every write is gated on the value actually differing. In steady state the HUD writes nothing at all |
| Every character built thirty-one `BoxGeometry` buffers and thirty-one materials, on every join **and** on every class change — a GPU upload storm landing as a hitch mid-firefight | All nine classes wear the same body, so the twenty-odd distinct box sizes are shared for the life of the page. Materials are cached per character (they are mutated by hit flashes and death fades, so they cannot be shared *between* characters): thirty-one become about thirteen |
| Every one of those thirty-one parts cast a shadow, doubling the character cost in the shadow pass | Fifteen parts whose shadow was already strictly *inside* somebody else's — the mask inside the head, the crown on the helmet, the pouches flush on the plate carrier — came out of it. A directional light casts a contained solid's shadow inside its container's, so this removes fifteen draws per player per frame and removes nothing anybody can see |
| Both particle clouds re-uploaded their entire capacity every frame — about twelve thousand floats — even with nothing alive, and the high-water mark never came back down | The upload is skipped when the cloud is empty, and the watermark follows the live tail rather than the write head |
| A closure allocated per frame for `requestAnimationFrame`, a `Vector2` per frame in the post chain, two `Vector3`s per frame in the death camera | Bound once, scratch objects reused |
| The shadow map redrew every casting solid in the level, from the light, on **every frame** — a second pass over as much geometry as the visible one, 144 times a second on a screen that fast | It is armed on a clock instead, at the quality preset's `shadowHz` (30–60). The sun's *direction* never changes as it follows the player, and three computes a shadow map and its matrix together — so a map one frame old is still pinned exactly where it was rather than swimming |
| The sky dome was drawn **first**, shading a full screen of texture that the level then covered up | Drawn last among the opaques, still writing no depth. The depth test rejects it wherever the map already stands, so only the sky you can actually see costs anything |
| With post-processing on, the canvas was still asked for a multisampled back buffer — which never sees a triangle of the world, because the world renders into the HDR buffer. It antialiased the two triangles of the composite quad and charged a full-screen resolve for it, every frame, at up to 2× device pixel ratio | The buffer is only asked for when the frame really does go straight to the canvas |
| Chromatic aberration, film grain and bloom were `if`s inside the composite shader: switching one off still ran its branch over every pixel, and bloom still cost a bright pass and two blurs to be multiplied by zero | Each is a `#define`. Turning one off recompiles the shader without it — and with bloom at zero the three passes behind it do not run at all |
| Four HUD panels and every killfeed row carried `backdrop-filter: blur()`. Behind them is a canvas that repaints every frame, so each one was a hidden second render pass — a backdrop copy and a blur — for the lifetime of every match, and the full-screen sheets over the menu were the same thing at full-screen size | Gone, with the panel tint carrying the legibility the frost was there for |
| A rifle is forty little boxes and a hand is a dozen, each its own draw call: about sixty a frame for the viewmodel alone, and another fifteen per body on screen | Every part that never moves relative to its neighbours is welded into one buffer per material at build time, and the result is cached per weapon-and-finish so eight players carrying the same rifle share the buffers rather than uploading eight copies. The magazine, bolt and cylinder stay separate, because the reload moves them |
| Every remote body was posed every frame — forty transform writes each, and thirty matrices for `updateMatrixWorld` to recompute — including the ones standing behind you | Bodies outside the camera frustum and more than 26 m away are left as they are. Inside that radius they are posed regardless, because a player just off the edge of the screen still throws a shadow across it |
| The minimap redrew on every frame, and the menu drew the live match behind itself at the display's full rate even with a settings panel or a modal covering it | Both are capped: the minimap at 60 Hz, the menu's backdrop at 60 Hz, and at 30 Hz when a full-screen sheet is over it. The skipped time is carried, not dropped, so the frame that does run ages everything over the whole interval |

**On the server**

| Was | Is |
| --- | --- |
| `roster` spread the player map into a fresh array and filtered it on every snapshot and every scoreboard push — twenty allocations a second per room before anybody had done anything | Cached, and invalidated only where membership or the spectator flag actually changes |
| A snapshot handed `JSON.stringify` the same eight player arrays once per recipient — 512 array serialisations a second in a full room | Each entry is serialised once and the per-player message is assembled from those strings. 64 a second instead of 512, and the room list is no longer a fixed eight |
| The lag-compensation ring allocated one object per player per tick — 480 a second per room, every one of them garbage inside a second | The ring is filled once and written through: six field writes |
| `levelFromXp` walked the curve a level at a time, evaluating two fractional powers per step, on every match payout and every admin write | A precomputed table and a binary search |

None of this is speculative: the test suite counts draw passes and material
batches, and `npm test` fails if a map stops fitting in one draw call per surface
material per shadow class.

### Wire protocol

JSON over one WebSocket at `/ws`, with short opcodes. Roughly **9 KB/s down per
client** in a full 12-player room. Client→server messages: `hello`, `in` (batched
input), `sh` (shoot), `ml`, `rl`, `sw`, `ch`, `md` (moderate), `rp` (report),
`ak` (acknowledge the server's round-trip token),
`sp` (move the spectator camera), `sm` (spectator mode on/off), `nk` (launch a
nuke), `gd` (god mode on/off, admins), `pi`, `rs`, `cl`, `pl`, `vo`. Server→client: `we` (welcome + map), `sn`
(snapshot), `jn`/`lv`, `ht`/`dm`/`kf`/`de`/`sp`, `fx`/`im`/`ex`, `ch`, `cs` (chat
standing), `rp` (report accepted or refused), `rt` (report standing — may you
file at all, and why not), `nk` (nuke armed / launched / aborted / detonated),
`gd` (god mode confirmed or refused), `af` (away from keyboard — warned, held,
cleared, or out), `sc`, `mt`, `am`, `po`, `er`.

Two of those are load-bearing rather than informational. `ak` answers the token
a `po` carried, the instant it lands, and the gap between the two is the round
trip lag compensation rewinds by — it has its own frame rather than riding the
next `pi` because the client only pings once a second, so echoing it there would
have timed *the gap between two heartbeats* and handed the whole room the
maximum rewind. A client's own `rtt` is still sent, and read only to be compared
against the measurement. And `sh` carries angles that are matched against the
view the same client streamed in its last `in`, rather than believed.
See [the anti-cheat](#the-anti-cheat).

A snapshot carries one entry per player on the roster plus the recipient's own
body, health and clock. Spectators get one field more — `sa`, the magazine of
the body their camera is on — because it is the only number on a spectator's HUD
that is not already in somebody's roster entry.

`de` — the one message a dying client gets — grew rather than gaining a sibling,
because everything the [kill cam](#the-kill-cam) draws is one fact about one
death and splitting it across two frames would only invite them to disagree. It
now carries the killer's badges, level and creator discipline, how far the shot
was, and how long the cam runs. The anthem travels as **a URL the server
resolved**, never a filename a client asked for: what plays into a dead player's
ears is chosen by the server, from a file it levelled itself, and there is no
field in the protocol a client could fill in to have something else played.

---

### The sound

**Every sound in the game is synthesised at runtime.** No audio files ship with
the project, nothing is preloaded, and the whole sound design is about thirty
kilobytes of `client/js/audio.js`. Four things do most of the work:

**Nothing is ever played twice the same way.** Every voice takes a small random
walk through pitch, level, filter and timing. A rifle emptying a magazine is
thirty *different* gunshots, which is the single largest difference between this
and a loop of one sample.

**Distance is a chain, not a volume knob.** A gunshot is five layers — the
transient click of the primer, a pitched punch, broadband body, the supersonic
crack, and the tail the map sends back. Near you it is crack and mechanism.
Eighty units away the crack is gone, the air has eaten the top end, the report
arrives a quarter of a second late at the real speed of sound, the direct sound
and its reflections have separated into a wide stereo image, and what is left is
mostly tail. That relationship is most of what makes a firefight legible by ear:
you can hear roughly where a fight is without looking at it.

**The room answers back.** Two convolution sends run in parallel, both built at
boot rather than loaded: a short one carrying discrete early reflections, which
is what tells the ear a space is enclosed, and a long diffuse one whose top end
dies faster than its bottom the way a real tail does. Every sound asks for a
different amount of each — a pistol indoors is mostly early reflections, a rocket
outdoors is almost entirely tail.

**The bus is mixed, not summed.** A gentle glue compressor, a `tanh` soft clipper
so the last few decibels bend instead of squaring off, and a fast brickwall.
Anything loud briefly ducks both reverb sends, so the next transient lands
somewhere clean instead of inside the wash of the last one. A hard cap of 72
concurrent voices keeps a ten-player firefight from turning the graph into
crackle.

Under all of it: three noise buffers rather than one. White for a supersonic
crack, pink for the body of an impact or a footstep, brown for the weight under
an explosion. Picking the right colour is worth more than any amount of filtering
the wrong one.

## Modding

Everything a player looks at is code, not content. There are no `.obj` files, no
texture atlases, no level editor and nothing to import: a map is a function that
returns boxes, a weapon is a list of boxes, a skin is a palette and a pattern
name. All three live in `shared/`, are loaded byte-identically by the client and
the server, and take effect on the next page load — the next page load *after a
rebuild*, if a build is what is being served. `CLIENT_DIR=client` drops the
rebuild while you are working; see [Building the client](#building-the-client).

Run `npm test` after any change here. The suite checks things that are easy to
break by hand and impossible to see: that every spawn point is clear and lands
on the ground, that no map traps a body, that every weapon's sights line up on
the crosshair, that nothing the player holds reaches the camera, and that no
finish paints a lens.

### Editing a map

Maps live in **`shared/maps.js`**. Each one is a function that pushes boxes into
an array and returns a description of the level.

```js
function mymap() {
  const boxes = [];
  const add = (...xs) => { for (const x of xs) boxes.push(...(Array.isArray(x) ? x : [x])); };

  add(road({ axis: 'z', at: 0, from: -50, to: 50, width: 14 }));
  add(house({ x: -20, z: -18, w: 14, d: 12, h: 5.2, wall: 0x2f6fd0, roofC: 0x4b525c,
              doors: [{ side: 'e', at: 0, w: 3.4 }], lip: 0.9 }));
  add(crates(8, 0, -6, 3, 1.4, 0xc08a3c));
  add(bounds(96));                                  // the invisible edge
  add(treeline(60, { count: 24 }));                 // scenery past it

  return {
    id: 'mymap', name: 'My Map',
    description: 'One line, shown in the map list.',
    size: 96, tags: ['street'],
    sky: { top: 0x2fb8ec, bottom: 0xa8e6fb, haze: 0xd6f3ff, clouds: 0.45 },
    fog: { color: 0xc4ecfb, near: 90, far: 260 },
    sun: { dir: [0.42, 0.82, 0.38], color: 0xfff6e0, intensity: 1.5 },
    ambient: { color: 0xbfe4fb, intensity: 0.8 },
    ground: { color: 0x6fbe4a, size: 340, mat: SURFACE.GRASS },
    boxes,
    spawns: { ffa: [[0, 0.3, -40, 0]], red: [[0, 0.3, -40, 0]], blue: [[0, 0.3, 40, Math.PI]] },
    objectives: [{ id: 'A', x: -20, y: 0.3, z: -18 }],   // optional — Domination only
  };
}
```

Then register it at the bottom of the file:

```js
const BUILDERS = { littletown, burgtown, sandstorm, shipyard, subzero, crossfire, nova, range, mymap };
export const MAP_IDS = [..., 'mymap'];   // omit to build it but keep it out of rotation
```

`BUILDERS` is what *exists*; `MAP_IDS` is what appears in the **rotation** and
the vote. The practice range is in the first and not the second, which is how a
map can be reachable by name without ever coming up between matches. Maps are
built once and memoised, so a builder runs at most one time per process.

**The three kinds of box.** `x`/`z` are the centre of the footprint, `y` is the
**bottom**, and `w`/`h`/`d` are full extents.

| | Collides | Renders | Stops bullets | Use it for |
| --- | --- | --- | --- | --- |
| `B(x, y, z, w, h, d, colour, opts)` | ✅ | ✅ | ✅ | The map itself |
| `D(…)` — decor | ❌ | ✅ | ❌ | Lawn trim, road paint, a window pane |
| `CLIP(x, y, z, w, h, d)` | ✅ | ❌ | ✅ | The boundary of the playable area |

The line between solid and decor is *what a player would expect*, not what is
cheap. Anything that reads as a mass is solid, whatever it costs the collision
world — tree canopies, hedges, benches, fence posts. Only genuinely flat or
genuinely overhead dressing stays decor.

**Options** on any box: `mat` (a `SURFACE` — picks the texture, the impact
particles, the ricochet sound and how solid it draws on the minimap), `roof:
true` (a walkable top), `noShadow: true` (skip the shadow pass — use it for
anything flush against the surface behind it, where the shadow would be inside
another shadow anyway), and `glow: <number>` (draw it bright instead of lighting
it — see the station set below).

**The builders you get for free** — all of them return arrays, so hand them
straight to `add()`:

| | |
| --- | --- |
| `bounds(size)` | The invisible wall around the playable area. Every map needs one. |
| `wallX` / `wallZ` | A wall with doorway gaps cut in it |
| `building({…})` | Four walls, doorways, an optional walkable roof and parapet |
| `house({…})` | A dressed `building`: siding, overhanging roof, glazed windows, doorway recess, optional chimney and porch |
| `stairs({…})` / `ramp({…})` | Stepped climbs — the shared step-up rule handles them |
| `road`, `crossing`, `pavement` | Carriageway, zebra stripes, kerbed footway |
| `fence`, `hedge`, `lawn`, `planter`, `bush`, `tree`, `treeline` | Garden and street greenery |
| `car`, `truck`, `container`, `crates`, `barrel`, `dumpster`, `bench`, `stall` | Props and cover |
| `lamp`, `pole`, `billboard`, `skyline` | Street furniture and the town past the boundary |
| `cover(x, y, z, w, d)` | A plain waist-high block — the fastest way to test a lane |
| `at(boxes, dx, dz)` | Translate a whole sub-assembly you have already built |

…and the station set, written for [Nova](#maps-and-modes) and for any other map
that has to be readable without a sun in it:

| | |
| --- | --- |
| `G(x, y, z, w, h, d, colour, i)` | An emissive box: drawn bright rather than lit, never solid, never a shadow caster. `i` is how far past white it pushes — around 1.5 reads as a lit surface, past 2 it throws a halo |
| `strip({…})` / `rimLight(…)` | A light line along an axis, and the four of them that mark the edge of a platform |
| `deck({…})` / `bridge({…})` | A walkable slab and a span between two of them, both with lit kerbs, optional rails and legs underneath |
| `railing(…)` / `railRun({…})` | Hip-high barrier with a lit cap, and a run of it with named gaps left where things arrive |
| `pylon`, `mast`, `holo`, `pod`, `windows` | A lit column, a beacon mast, a hologram panel, lit cargo and a window band |

The rule the set follows is **light marks what you can stand on**. Every
walkable edge glows and nothing else does, so a player reading a night map at a
glance is reading a map of its routes — the same job the bright roofs do on the
town maps, moved to a level where the sun is not available to do it.

**The sky.** By default it is painted once into a canvas and wrapped round a
dome: a gradient, a sun disc, horizon haze and a band of cloud scaled by
`sky.clouds`. Give the map a `sky.nebula` instead and it becomes a shader —

```js
sky: {
  top: 0x070a1a, bottom: 0x2a1042, haze: 0x3d1a55,
  nebula: { warm: 0xff4fa3, cool: 0x3f86ff, density: 1.05, speed: 1 },
},
```

— two fields of gas drifting past each other at different rates, stars twinkling
behind them, and a meteor every few seconds, all derived from one clock so every
screen in the match sees the same sky. It costs one uniform per frame and only
shades the sky the player can actually see past the level, because the dome is
drawn last with the depth test on. `warm` and `cool` are the two colours the gas
is mixed between, `density` is how far it may lift the sky (past about 1.4 it
stops reading as gas and starts reading as fog), and `speed` scales the whole
animation.

**Spawns** are `[x, y, z, yaw]`, keyed by `ffa`, `red` and `blue`. Give a body
about 0.3 of clearance above the floor it stands on. `npm test` walks every
spawn on every rotation map, drops a body on it for five seconds and fails if it
starts inside geometry, never settles, or falls out of the world — so a bad
spawn is a failing test rather than a bug report.

**Objectives** are the Domination capture points, ordered A → B → C. Leave the
array out and the map simply never comes up in that mode.

To try it without waiting for a rotation, add a permanent room for it in `.env`
and restart: `ROOMS=…,mymap:ffa`. Once it is in `MAP_IDS` it also comes up on
its own, in the rotation and in the intermission vote.

### Weapons and their models

Weapons live in **`shared/weapons.js`** — nine classes, each with a signature
primary, plus the pistol and the knife every class carries. The numbers and the
model sit in the same object, so a weapon is one thing to read.

A model part is:

```js
{ p: [x, y, z], s: [w, h, d], c: 0x2e343d, m: MAT.METAL, z: ZONE.BODY,
  r: [rx, ry, rz], tag: 'mag', fine: 1 }
```

| | |
| --- | --- |
| `m` | How it is shaded: `METAL`, `ALLOY`, `POLY`, `WOOD`, `RUBBER`, `GLASS`, `EMIT`. This is what separates blued steel from matte polymer. |
| `z` | Which part of the gun it is — see **Skins** below. Skins paint zones. |
| `tag` | Ties it to an animation: `mag` drops on a reload, `slide` and `bolt` cycle, `pump` rides the pump, `cyl` is a revolver cylinder. |
| `fine` | Detail work. The first-person viewmodel draws every part; the third-person body skips these. Nobody reads slide serrations at forty metres, and eight players' worth of them is a few hundred draw calls a frame that buy nothing. |

The gun points down **−Z**, up is **+Y**, right is **+X**. Alongside the parts,
the model declares the handful of points everything else is derived from:

| | |
| --- | --- |
| `muzzle` | Where the flash and the tracer leave |
| `eject` | Where the case comes out |
| `sight` | The point that must sit **dead centre** when aiming. The whole aim-down-sights pose falls out of this — mark the rear notch and the gun lines up on the crosshair the first time, with no hand-tuned offset. |
| `grip` + `gripTilt` | Where the trigger hand goes, and how far the grip is raked back |
| `fore` + `foreKind` | Where the support hand goes, and what it is holding: `fore` (a horizontal handguard), `vert` (a vertical foregrip), `pump`, `cup` (cradling a pistol butt), `idle` (empty), `none` |

The hands are built *at* those two points — palm, four fingers, a thumb, an
index finger laid on the trigger, a bare wrist and a sleeved forearm. Move a
grip and the fingers follow it, because they are placed from the same numbers.

Where a weapon *rests* on screen is the one thing that is not in this file:
`REST` in `client/js/viewmodel.js` holds a per-`kind` offset, because a rifle is
held into the shoulder and a pistol is held out at arm's length, and framing
them identically pushes a butt stock behind the camera. It applies to the hip
pose only — an aimed weapon is placed by its sights and by nothing else.

To add a class, copy the nearest existing one in `CLASSES`, change the id, and
it appears in the class picker, the gun-game ladder and the shop automatically.

### Cosmetics

Everything a player can own, wear, carry, open, trade or sell is declared once
in `shared/cosmetics.js` and read identically by the browser, the game server
and the admin panel. Nothing downstream invents an item.

**A cosmetic is an item in a slot.** There are nine:

| Slot | What it is |
| --- | --- |
| `primary` `secondary` `knife` | the three guns, each finished independently |
| `gloves` | what the hands the viewmodel draws are in |
| `head` `face` `body` `back` | the operator everybody else sees |
| `charm` | a trinket hung off the primary |

An item id is `<slot>:<key>` — `primary:gold`, `knife:doppler`, `head:crown`.
Slot-prefixed on purpose: `gold` alone is ambiguous the moment the same finish
exists on three guns, and every id that reaches the database, the market or a
trade has to name exactly one thing.

Only `primary` is remembered **per class** — everybody wants a different paint
on a sniper than on an SMG, and nobody wants different gloves depending on
which one they picked.

#### Weapon finishes

A finish is **not a tint**. Dipping every part of a rifle in one colour makes
the wood, the steel and the polymer the same shade of nothing. Three things
make a finish instead, declared in `FINISHES`:

```js
crimson: {
  name: 'Crimson', rarity: 'rare', on: WEAPON_SLOTS,
  paint:   { body: 0xa41f2c, wood: 0x241b1f, metal: 0x1a1e23, accent: 0x7c1621 },
  pattern: { kind: 'stripe', on: ['body'], colors: [0xc02434, 0x8c1926, 0x1a1418], scale: 0.22 },
  gloss: 1,
  glove: 0xb01f2e,
  blurb: 'Racing stripes on something that is not a car.',
},
```

* **Zones.** Every model part declares which piece of the gun it is (`ZONE` in
  `shared/weapons.js`) and a finish paints zones, not weapons. Gold Rush gilds
  the receiver and leaves the butt pad black rubber. The `detail` zone —
  lenses, reticles, brass, bores — is never painted, which is what keeps a gold
  rifle's optic made of glass.
* **Pattern.** One of 27 seamless tiles painted on a 128px canvas at load time:
  `digital`, `splinter`, `blotch`, `scratch`, `splatter`, `stripe`, `hex`,
  `fade`, `grid`, `scroll`, `damascus`, `circuit`, `stencil`, `tiger`,
  `marble`, `chevron`, `serpent`, `nebula`, `starfield`, `wave`, `crackle`,
  `topo`, `oil`, `crystal`, `flame`, `plasma`, `web`. Nothing is downloaded.
* **Finish.** Gloss and an optional emissive rim, layered on the material's own
  shading, so polished gold and matte olive drab are *lit* differently rather
  than tinted differently.

`on` lists the gun slots a finish may be minted for. A finish declared once
becomes one item per slot, priced by the slot: a knife finish is worth more
than the same paint on a sidearm because far fewer people are looking at a
sidearm.

#### Worn cosmetics

Hats, faces, packs, gloves and charms are **recipes rather than meshes** — a
`shape` naming a builder `client/js/wearables.js` already knows, plus two or
three colours. That is deliberate. A cosmetic that shipped its own mesh would
mean an asset pipeline, a download, a cache and a loading screen; one that
names a shape and three colours is four hundred bytes and draws on the frame it
is equipped.

The same builders draw the operator in the match *and* the operator on the
loadout screen, so nothing can be bought on the strength of a preview that
lies.

#### Rarity, and the animated tier

Six tiers — common, uncommon, rare, epic, legendary, mythic — and
`RARITY[x].weight` is the only thing a case roll consults. Forty-two items are
**animated**: the pattern scrolls, the emissive breathes, or the hue rotates.
Nothing animated sits below legendary, which is the whole promise of the tier.

Motion costs almost nothing: `tickCosmetics()` in `client/js/gunskin.js` walks
two short lists once a frame and moves *shared* texture offsets and *shared*
material emissives, so forty players in Hellfire cost exactly what one does.

#### Cases

A case is a priced roll over a slice of the catalogue. `pool` is a filter
rather than a list, so adding an item to the catalogue puts it in every case
that already described it.

Two draws, not one: the tier is chosen against the published weights and then
the item is chosen uniformly inside it. Rolling flat over the pool instead
would make a tier's odds depend on how many items happen to be in it, so adding
one more legendary would quietly make legendaries commoner.

**The odds a case publishes are the odds it rolls** — `caseOdds()` is read by
the shop card *and* by `rollCase()`, so the two cannot drift apart. The roll
happens on the server, from `node:crypto`, inside the same transaction that
charges for it, and every opening is kept forever in `case_openings`. The admin
panel puts the realised rates beside the published ones; if they ever disagree
by more than sampling noise, the roll is wrong and that is how anybody would
find out.

#### The market and trades

An owned cosmetic is a **unit**, not a flag: one row per copy, each with its own
id, its own serial number and its own provenance. A boolean "owns gold" could
not be sold once without taking away the copy that was equipped.

Three rules run through every economic path in `server/db/index.js`:

1. **A locked unit does not move.** Locked means staked in an open trade or
   standing on the market, and every mover re-checks it *inside* the same
   transaction it writes in — not before, where a second request could slip
   between the check and the write.
2. **GR and units move together or not at all.** One helper does both, and
   everything routes through it.
3. **Nothing trusts an item id.** `getItem` returns null rather than inventing
   one.

The market takes a tenth of every sale and burns it, which is the only GR sink
trading has. The game itself will buy a duplicate back for a fifth of catalogue
— deliberately a bad deal, because that is the floor under the market rather
than a way to play it.

Trades are **friends-only**. Not a limitation, a defence: every scam an item
economy has ever had starts with an offer from a stranger, and the friend list
is a barrier the player already controls. Anybody who wants to deal with a
stranger has the market, where nobody can be talked into anything.

#### Adding an item

Add a row to the right table in `shared/cosmetics.js` and it appears
everywhere: the loadout grid, the cases whose pool describes it, the market's
filters, the admin panel's catalogue counts. Nothing else has to be kept in
step.

**One caution about ids.** An item id is what is written into `inventory` in
the database. Renaming or removing one takes it away from everybody who had
bought it — change the look, keep the id.


---

## REST API

Base URL: `https://grunker.g0x.dev/api/v1`

Authentication is a bearer token, also set as an `HttpOnly` cookie:
`Authorization: Bearer <token>`.

### Public

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Server status, uptime, tick timings |
| `GET` | `/meta` | Modes, maps, classes, skins, protocol version |
| `GET` | `/servers` | Room list with codes, population and match state |
| `GET` | `/leaderboard?sort=&limit=&offset=` | `sort`: `kills`, `score`, `level`, `xp`, `wins`, `kd`, `headshots`, `damage`, `gr` |
| `GET` | `/players/:name` | The card: profile, styling, stats and recent matches, minus anything its owner has not shared with this viewer. Also `relation` (`self` · `friend` · `none`), `hidden` (the sections withheld), `can` (`add` · `join` · `seePresence`), `pending` and `presence`. Reads signed out too |
| `GET` | `/players/:name/matches?limit=` | Recent match history |
| `GET` | `/stats/global` | Account, match and online counts |
| `GET` | `/clans?q=&limit=&offset=` | Every clan, ranked by its members' combined match score |
| `GET` | `/clans/:tag` | One clan with its roster |
| `GET` | `/avatars/:file` | A stored profile picture *(not under `/api`)* |
| `GET` | `/avatars/clans/:file` | A stored clan picture *(not under `/api`)* |

### Accounts

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/auth/register` | `{ username, password, email, turnstileToken }` |
| `POST` | `/auth/login` | `{ username, password, turnstileToken, code }` — `code` is the second factor, six digits or a recovery code. Omitting it on an account that has 2FA answers `401 totp_required` with no token |
| `POST` | `/auth/logout` | — |
| `GET` | `/auth/me` | *(auth)* profile, stats, loadout and verification state |
| `POST` | `/auth/password` | *(auth)* `{ current, next, code }` — `code` required while 2FA is on |
| `POST` | `/auth/totp/setup` | *(auth)* draws a secret and its `otpauth://` URI. Stores nothing |
| `POST` | `/auth/totp/enable` | *(auth)* `{ secret, code, password }` → the ten recovery codes, shown once |
| `POST` | `/auth/totp/disable` | *(auth)* `{ password, code }` |
| `POST` | `/auth/totp/recovery` | *(auth)* `{ password, code }` → a new set; the old one dies immediately |
| `GET` | `/auth/totp` | *(auth)* whether it is on, and how many recovery codes are left |
| `POST` | `/auth/username` | *(auth)* `{ username }` — spends `RENAME_COST` GR |
| `POST` | `/auth/verify` | `{ token }` from a confirmation link; works signed out |
| `POST` | `/auth/verify/resend` | *(auth)* a fresh link, invalidating the last one |
| `POST` | `/auth/email` | *(auth)* `{ email, password }` — corrects the address and re-sends |
| `POST` | `/avatar` | *(auth)* the image **as the raw body**, not a form — see below |
| `DELETE` | `/avatar` | *(auth)* back to the initials |
| `GET` | `/profile/social` | *(auth)* your card, your privacy answers, and every value either may take |
| `PUT` | `/profile/card` | *(auth)* `{ card }` — normalised before it is stored; answers with what is now true |
| `PUT` | `/profile/privacy` | *(auth)* `{ privacy }` — same contract |
| `GET` | `/reports/mine` | *(auth)* every report you filed, and what became of each |
| `GET` | `/challenges` | *(auth)* today's three, this week's three, and all twenty-one career milestones with your progress on each |
| `GET` | `/mastery` | *(auth)* per-weapon kills and tier |

`POST /avatar` takes the bytes themselves with the image's own `Content-Type`;
there is no multipart form and no base64 envelope. It answers `unsupported_image`
(400, the magic bytes are not PNG/JPEG/WebP), `image_too_big` (400, past
`AVATAR_MAX_DIM`), `image_too_large` / `413` (past `AVATAR_MAX_BYTES`) or
`image_too_small` (400, under 16×16).

Reports are **filed over the game socket**, not here: the room is the only thing
that knows who was actually in the match. `/reports/mine` is the other half of
that loop — the verdict a moderator wrote, read back by the player who asked.

`/meta` publishes what these routes expect: the two Turnstile **site** keys, the
rename price, whether an address is required and enforced, the avatar limits the
client downscales to, the report reasons with every ceiling on filing them, and
the clan rules — the two level gates, the founding price and the tag limits.

Beyond the usual statuses, these routes answer `captcha_failed` (400, or 503
when Cloudflare itself is unreachable), `email_required` (400), `bad_token`
(400, an expired or already-spent link), `vpn_blocked` (403), `resend_cooldown`
(429), `insufficient_gr` (402), `totp_required` (401, the password was right and
the second factor is still owed) and `totp_invalid` (401, wrong or already
spent).

### Friends

Every one of these answers with the **whole** payload — the list, both queues and
who is online — rather than the row it changed, because accepting a request moves
a name from one column to another and may bring a room code with it, and two
round trips to draw that is a panel that flickers.

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/friends` | *(auth)* the list with live presence, `incoming`, `outgoing`, and the ceilings |
| `POST` | `/friends/requests` | *(auth)* `{ username }` — answers `outcome: "sent"`, or `"accepted"` when they had already asked you |
| `POST` | `/friends/requests/:id/accept` | *(auth)* `:id` is the **asker's** account id |
| `DELETE` | `/friends/requests/:id` | *(auth)* declining theirs and cancelling yours are the same row |
| `DELETE` | `/friends/:id` | *(auth)* ends it for both — there was only ever one row |

A friend who is playing comes back with `playing: true` and the `room` code the
server browser joins by; a full room answers `full: true` and `room: null`,
because a room nobody can enter is not an invitation, and a friend who has closed
their matches answers `closed: true` instead — "full" and "they do not take
visitors" are different sentences and a row that says the wrong one reads as the
server being wrong about a friend. A friend who has switched presence off does
not appear online at all, to anybody, their friends included. These answer
`already_friends` (409), `already_asked` (409), `list_full` (409), `too_many`
(409), `level_too_low` (403) and `rate_limited` (429).

### Clans

Invite-only, one clan per player, and every rule below is checked here rather
than in the browser. `/meta` publishes the levels, the price and the tag limits
so the client never hard-codes them.

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/clans/mine` | *(auth)* your clan, your invitations, and what you may do |
| `POST` | `/clans` | *(auth)* `{ tag }` — needs `CLAN_CREATE_LEVEL` and spends `CLAN_CREATE_COST` GR |
| `POST` | `/clans/:tag/invites` | *(owner)* `{ username }` |
| `DELETE` | `/clans/:tag/invites/:name` | *(owner)* cancel an invitation |
| `POST` | `/clans/:tag/join` | *(auth)* accept one — needs `CLAN_JOIN_LEVEL` |
| `POST` | `/clans/:tag/decline` | *(auth)* turn one down; nobody is told |
| `POST` | `/clans/:tag/leave` | *(member)* the owner cannot: hand it over or disband it |
| `DELETE` | `/clans/:tag/members/:name` | *(owner)* remove somebody |
| `POST` | `/clans/:tag/transfer` | *(owner)* `{ username }` — the old owner stays as a member |
| `POST` | `/clans/:tag/avatar` | *(owner)* the image **as the raw body**, exactly like `/avatar` |
| `DELETE` | `/clans/:tag/avatar` · `/clans/:tag` | *(owner)* drop the picture, or disband |

These answer `invalid_tag` (400), `tag_taken` (409), `already_in_clan` (409),
`level_too_low` (403), `insufficient_gr` (402), `not_owner` (403), `not_invited`
(403), `clan_full` (409) and `owner_cannot_leave` (409).

The GR for founding a clan is taken first and refunded if the tag turns out to be
gone: the unique index on the tag, not the `SELECT` before it, is what settles a
race between two people founding the same four characters in the same second.

### Loadout and the wardrobe

The catalogue itself is **not** served over HTTP — it is a static module the
browser imports (`/shared/cosmetics.js`), so the client and the server read the
same definitions out of the same file. These routes carry only what the server
knows and the client cannot: who owns what, what it is selling for, and who is
offering what to whom.

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/loadout` | *(auth)* |
| `PUT` | `/loadout` | *(auth)* `{ classId?, equip?, primaries?, settings?, keybinds? }` |
| `GET` | `/wardrobe` | *(auth)* — units held, what is equipped, what may be |
| `POST` | `/shop/buy` | *(auth)* `{ itemId }` — spends GR at catalogue price |
| `POST` | `/wardrobe/scrap` | *(auth)* `{ unitId }` — sells it back to the game |
| `POST` | `/cases/open` | *(auth)* `{ caseId }` — charges, rolls, mints, audits |
| `GET` | `/cases/recent` | the live drop feed |
| `GET` | `/cases/history` | *(auth)* your own openings |
| `GET` | `/market` | `?slot=&rarity=&q=&sort=` — one row per item |
| `GET` | `/market/item` | `?id=` — standing listings and recent sale prices |
| `GET` | `/market/mine` | *(auth)* |
| `POST` | `/market/list` | *(auth)* `{ unitId, price }` |
| `POST` | `/market/cancel` | *(auth)* `{ listingId }` |
| `POST` | `/market/buy` | *(auth)* `{ listingId }` |
| `GET` | `/trades` | *(auth)* open offers and settled history |
| `POST` | `/trades` | *(auth)* `{ to, give[], want[], giveGr, wantGr, note }` |
| `POST` | `/trades/accept` | *(auth)* `{ id }` |
| `POST` | `/trades/close` | *(auth)* `{ id }` — withdraw or decline |

### Admin *(private network only)*

Served on `ADMIN_PORT` (7421), never through nginx, and refused outright for any
request that arrived via a proxy. Sign in with `POST /api/v1/admin/login`
`{ password }` and pass the returned token as `X-Admin-Token`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/admin/status` | Whether the panel is enabled, configured and reachable |
| `POST` | `/admin/login` · `/admin/logout` | Password from `ADMIN_PASSWORD` |
| `GET` | `/admin/overview` | Database, room and process health |
| `GET` | `/admin/players?q=&sort=&limit=&offset=` | Search and page accounts. Every connected guest rides at the top of the first page as `guest: true`, with `guests` counting them |
| `GET` | `/admin/players/:id` | One account, its stats and recent matches |
| `PATCH` | `/admin/players/:id` | Username, email, email confirmation, role, verified badge, GR, level, XP, stats. `clan: null` pulls the account out of its clan — the tag is a membership row, not a free-text field |
| `POST` | `/admin/players/:id/ban` · `/unban` | `{ days, reason, ip }` — `days: 0` is permanent, `ip: true` (default) bans every address the account plays from |
| `POST` | `/admin/players/:id/mute` · `/unmute` | `{ minutes, reason }` — chat ban only; `minutes: 0` is permanent |
| `POST` | `/admin/players/:id/report-ban` · `/report-unban` | `{ minutes, reason }` — switches the **REPORT** button off for this account and nothing else. `minutes: 0` is indefinite; the reason is what they read on the greyed button |
| `GET` | `/admin/report-bans` | Every account currently blocked from reporting |
| `GET` | `/admin/chat-bans?limit=` | Every live chat ban |
| `GET` `POST` | `/admin/ip-bans` | List address bans, or add one: `{ ip, reason, days }` |
| `DELETE` | `/admin/ip-bans/:ip` | Lift one address ban |
| `GET` | `/admin/reports?status=&q=&limit=&offset=` | The queue; open reports sort first. `status`: `open`, `actioned`, `rejected` |
| `GET` | `/admin/reports/:id` | One report with the chat snapshot, both accounts and everything else filed about the target |
| `POST` | `/admin/reports/:id/resolve` | `{ status, action, outcome }` — `outcome` is the line the reporter reads |
| `POST` | `/admin/reports/:id/reopen` | Put a settled report back in the queue |
| `DELETE` | `/admin/reports/:id` | Drop it — the reporter never hears back |
| `DELETE` | `/admin/players/:id/avatar` | Take a profile picture away, without banning anybody |
| `GET` | `/admin/clans?q=&limit=&offset=` | Every clan, with its owner and standing |
| `GET` | `/admin/clans/:id` | One clan, its roster and its outstanding invitations |
| `POST` | `/admin/clans/:id/verify` | `{ verified }` — the gold tag, and nothing else |
| `DELETE` | `/admin/clans/:id/avatar` · `/admin/clans/:id` | Take the picture, or disband the clan |
| `POST` | `/admin/players/:id/password` · `/kick` | Reset a password, or drop live sockets |
| `DELETE` | `/admin/players/:id` | Delete the account and everything it owns |
| — | `:id` = `guest:<n>` | A guest, addressed by their live connection. `GET`, `/ban`, `/unban` and `/kick` accept it; a ban on one is a ban on the address, and every other route answers `guest_has_no_account`. The id stops resolving the moment they disconnect (`guest_gone`) |
| `GET` | `/admin/logs?level=&limit=` | Server log ring buffer plus the admin audit trail |
| `GET` | `/admin/stats?hours=` | The whole STATS tab in one request: live health, every sampled series bucketed to ~200 points, match/map/mode/class mix, retention, the level histogram and the economy |
| `GET` | `/admin/stats/series` | Every series the sampler writes, with its label and how a chart should aggregate it |
| `GET` | `/admin/stats/events?kind=&limit=` | The raw event journal, newest first |

Errors are `{ "ok": false, "error": "<code>", "message": "<human text>" }` with a
matching HTTP status. Requesting `/api` or an unknown version returns a 404 that
names the versions the server does support.

```bash
curl https://grunker.g0x.dev/api/v1/health
curl -X POST https://grunker.g0x.dev/api/v1/auth/register \
     -H 'content-type: application/json' \
     -d '{"username":"yourname","password":"a-good-password"}'
curl https://grunker.g0x.dev/api/v1/leaderboard?sort=kd&limit=10
```

---

## Configuration

Copy `.env.example` to `.env`; every value has a working default.

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `7420` | **8080 and 8081 are deliberately avoided** — they are taken on this host |
| `DYNAMIC_ROOMS` | `true` | Open and close rooms with the crowd; `false` pins the list to `ROOMS` |
| `ROOMS_MAX` | `32` | Hard ceiling on the room count. About CPU, not seats |
| `ROOM_HEADROOM` | `2` | Open another room of a mode once its free seats reach this |
| `ROOM_IDLE_SEC` | `120` | Close a surplus room once it has been completely empty this long |
| `ROOM_CHECK_SEC` | `5` | How often the balancer reconsiders the list |
| `METRICS_ENABLED` | `true` | Sample telemetry for the admin panel's STATS tab |
| `METRICS_INTERVAL_SEC` | `300` | One row per series per interval. 288 points a day |
| `METRICS_KEEP_DAYS` | `90` | Samples and events older than this are pruned hourly |
| `PUBLIC_URL` | `https://grunker.g0x.dev` | Used for cookie `Secure` and logging |
| `CORS_ORIGINS` | site + localhost | Comma-separated allow-list |
| `DB_PATH` | `data/open-grunker.db` | WAL-mode SQLite file |
| `CLIENT_DIR` | *(the build, else the sources)* | `client/dist` once `npm run build` has made one, `client` until then |
| `SERVE_STATIC` | `true` | Set `false` when nginx serves the client |
| `ROOMS` | four rooms | `"<map>:<mode>"`, comma-separated |
| `REGION` | `FRA` | Prefix in shareable match codes, e.g. `FRA:7K2Q` |
| `MAX_PLAYERS_PER_ROOM` | `8` | |
| `BOTS_ENABLED` / `BOT_COUNT` | `true` / `4` | Bots make room for real players as they join |
| `SESSION_TTL_DAYS` | `30` | |
| `REGISTRATION_OPEN` | `true` | Set `false` to close sign-ups |
| `RATE_MAX_REQUESTS` | `240`/min/IP | `RATE_MAX_AUTH` is `12`/min/IP |
| `MAX_WS_PER_IP` | `6` | |
| `ADMIN_PASSWORD` | *(empty)* | Set it to enable the admin panel; empty disables it |
| `ADMIN_HOST` / `ADMIN_PORT` | `0.0.0.0` / `7421` | The panel's own listener, separate from the game |
| `ADMIN_ALLOW_LAN` | `true` | Accept private LAN addresses too, not just loopback |
| `ADMIN_LOCAL_ONLY` | `true` | Refuse anything from outside this network. Leave it on |
| `BAN_APPEAL_CONTACT` | `appeal@grunker.g0x.dev` | Address shown on the ban screen |
| `REPORTS_ENABLED` | `true` | The scoreboard's REPORT button and the queue behind it |
| `REPORTS_MIN_LEVEL` | `5` | Below this an account can play but not report |
| `REPORTS_COOLDOWN_SEC` | `60` | Between any two reports from one account |
| `REPORTS_MAX_PER_HOUR` | `6` | Per account. Beyond it the button is refused |
| `REPORTS_MAX_PER_DAY` | `15` | So the hourly cap cannot be waited out all night |
| `REPORTS_MAX_OPEN` | `5` | Reports of yours a moderator may still have unread. Handed back as the queue is worked |
| `REPORTS_REPEAT_COOLDOWN_SEC` | `600` | Before the same reporter may file on the same player again |
| `REPORTS_DISMISSED_MAX` | `5` | Dismissals inside the window before the button shuts. `0` disables it |
| `REPORTS_DISMISSED_WINDOW_DAYS` | `7` | How far back dismissals count |
| `REPORTS_DISMISSED_LOCKOUT_HOURS` | `24` | Measured from the last dismissal, so it clears itself |
| `REPORTS_KEEP_RESOLVED_DAYS` | `0` | Days a *settled* report is kept. `0` keeps it for good — the HANDLED tab is the history behind a name. Open ones are never pruned either way |
| `FRIENDS_ENABLED` | `true` | The friends panel and everything under `/friends` |
| `FRIENDS_MAX` | `100` | Friends one account may hold |
| `FRIEND_REQUESTS_MAX` | `40` | Requests one account may have outstanding |
| `FRIEND_REQUESTS_INBOX_MAX` | `60` | Requests that may be waiting for one account to answer |
| `FRIEND_REQUEST_COOLDOWN_SEC` | `5` | Between any two requests from one account |
| `FRIEND_MIN_LEVEL` | `2` | A fresh throwaway account is not somebody's friend |
| `AFK_ENABLED` | `true` | Counting away-from-keyboard at all |
| `AFK_WARN_SEC` | `75` | Seconds without a key held or the view moving before the notice, which also holds the automatic respawn |
| `AFK_KICK_SEC` | `105` | And before the seat goes back and the player lands in the menu |
| `ANTICHEAT_ENABLED` | `true` | Scoring refusals and acting on them. The refusals themselves happen regardless |
| `ANTICHEAT_KICK` | `true` | Drop the connection at the threshold, or only warn, log and file the report |
| `ANTICHEAT_WARN_SCORE` / `ANTICHEAT_KICK_SCORE` | `40` / `120` | Points, decaying at 0.6/s. A silent-aim shot is 12, a claimed round trip 8 |
| `CLANS_ENABLED` | `true` | Founding and joining clans at all |
| `CLAN_JOIN_LEVEL` | `5` | Needed to accept an invitation |
| `CLAN_CREATE_LEVEL` / `CLAN_CREATE_COST` | `15` / `1000` | What founding one takes, and what it costs in GR |
| `CLAN_MAX_MEMBERS` | `24` | Owner included |
| `CLAN_MAX_INVITES` / `CLAN_INVITE_TTL_HOURS` | `25` / `72` | Outstanding invitations one clan may hold, and how long each lives |
| `CLAN_AVATAR_DIR` | `data/clans` | Clan pictures, served from `/avatars/clans/` under the same ceilings as an avatar's |
| `AVATARS_ENABLED` | `true` | Profile picture uploads |
| `AVATAR_DIR` | `data/avatars` | One file per account, beside the database |
| `AVATAR_MAX_BYTES` | `196608` | 192 KB. The client uploads ~20 KB |
| `AVATAR_MAX_DIM` | `512` | Refused past this, whatever the file size says |
| `AVATAR_CACHE_SEC` | `31536000` | Safe at a year: the filename is a content hash |
| `CREATORS_ENABLED` | `true` | [Creator status](#creator-status) at all. `false` closes the routes, the queue *and* the rail entry; anything already approved keeps working |
| `CREATORS_MIN_LEVEL` | `5` | Before an account may apply |
| `CREATORS_NEED_EMAIL` | `true` | A confirmed address as well. Only bites where email verification is on |
| `ANTHEM_DIR` | `data/anthems` | One levelled WAV per music creator, beside the database |
| `ANTHEM_MAX_BYTES` | `720896` | Ten seconds of mono 16-bit PCM at 32 kHz is 640 KB |
| `ANTHEM_CACHE_SEC` | `31536000` | A year. The filename is a content hash, and this is fetched mid-match |
| `DEV_MODE_ENABLED` | `true` | [Developer mode](#developer-mode) at all |
| `DEV_MODE_LEVEL` | `10` | Where the overlays unlock. Code creators skip the gate |
| `DEFAULT_LANGUAGE` | `en` | The [interface language](#languages) a visitor gets when their browser has not asked for one the game ships. Never a lock: a player's own choice wins, and so does a browser that has already asked |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

### Anti-bot, email, VPN and sessions

| Variable | Default | Notes |
| --- | --- | --- |
| `TURNSTILE_ENABLED` | `true` | Master switch for both widgets |
| `TURNSTILE_SITEKEY_REGISTER` / `_SECRET_REGISTER` | *(empty)* | Sign-up widget. No secret = that form is not challenged |
| `TURNSTILE_SITEKEY_LOGIN` / `_SECRET_LOGIN` | *(empty)* | Sign-in widget, its own key pair |
| `EMAIL_VERIFICATION` | `true` | Issue and accept confirmation links at all |
| `EMAIL_REQUIRED` | `true` | An address is mandatory at sign-up |
| `EMAIL_VERIFY_ENFORCE` | `true` | An unconfirmed account cannot enter a match. **Leave false until mail works** |
| `EMAIL_VERIFY_TTL_HOURS` | `48` | How long a link lives |
| `EMAIL_RESEND_COOLDOWN_SEC` | `120` | Between two "resend" requests |
| `MAIL_TRANSPORT` | `log` | `log` writes the link to the journal; `smtp` sends it |
| `SMTP_HOST` / `SMTP_PORT` | *(empty)* / `587` | See [docs/EMAIL.md](docs/EMAIL.md) |
| `SMTP_SECURE` / `SMTP_STARTTLS` | `false` / `true` | Implicit TLS (465), or plain connect then STARTTLS (587) |
| `SMTP_USER` / `SMTP_PASS` | *(empty)* | Most providers want an API key, not a password |
| `MAIL_FROM` / `MAIL_FROM_NAME` | `no-reply@g0x.dev` | Must be on the domain the provider verified |
| `VPN_BLOCK` | `true` | Refuse VPNs, proxies, Tor exits and datacenters |
| `VPN_PROVIDER` | `ipapi` | `ipapi`, `proxycheck` (needs `PROXYCHECK_KEY`) or `none` |
| `VPN_BLOCK_HOSTING` | `true` | Relax this first if real players get caught |
| `VPN_FAIL_OPEN` | `true` | Let people in when the lookup itself fails |
| `VPN_ALLOWLIST` | *(empty)* | Addresses and CIDRs never checked |
| `VPN_CACHE_HOURS` | `72` | How long a verdict is trusted |
| `SINGLE_SESSION` | `true` | One account, one live game |
| `SINGLE_SESSION_POLICY` | `takeover` | Or `refuse` — see above |
| `RENAME_COST` | `100` | GR a signed-in player pays for a new nickname |
| `CF_PROXY` | `false` | Trust `CF-Connecting-IP`. Only true behind Cloudflare's proxy |

After editing `.env`: `sudo systemctl restart open-grunker`.

---

## Deployment

`scripts/setup.sh` does all of this; the pieces are:

**1 — systemd** (`deploy/systemd/open-grunker.service`) runs the server as
`www-data` with `ProtectSystem=strict` and write access limited to `data/`.

**2 — nginx** (`deploy/nginx/grunker.g0x.dev.conf`) serves the client directly
out of `client/dist` — so a deploy runs `npm run build` first — proxies `/api/`
and `/ws` to `127.0.0.1:7420`, gzips JavaScript, hands every hashed chunk a
year-long `immutable` and keeps WebSocket connections alive for the length of a
match. It answers `/admin` and `/api/v1/admin` with a flat 404: the panel is not
part of the public site.

**3 — DNS.** Add a record for `grunker` in the `g0x.dev` zone — an `A`/`AAAA` to
this host, or a `CNAME` to `g0x.dev`. Behind Cloudflare, leave the orange cloud
on (WebSockets are supported) and keep SSL mode on **Full**, matching the other
sites on this box.

Verify without DNS:

```bash
curl -sk --resolve grunker.g0x.dev:443:127.0.0.1 https://grunker.g0x.dev/api/v1/health
```

---

## Admin panel

A small console for moderating accounts, on its own listener so the game server
keeps its loopback-only binding:

```
http://127.0.0.1:7421/admin          from this machine
http://<lan-ip>:7421/admin           from a phone or laptop on the same network
```

Set `ADMIN_PASSWORD` in `.env` and restart. Five tabs:

- **Stats** — everything the server knows about itself, over any window from six
  hours to ninety days. See below.
- **Players** — search, page and edit any account: username, email, role, the
  verified check (`/check.png`), GR, level, XP and every lifetime stat. Ban for
  a number of days or permanently, lift a ban, chat-ban for a number of minutes
  or permanently, remove a profile picture, pull the account out of its clan,
  reset a password, kick live sockets, or delete the account outright. Each
  account also shows what has been reported about it and what it has reported
  about others. **Guests appear here too, at the top of the first page, for as
  long as they are connected** — see below.
- **Reports** — the moderation queue in two tabs, OPEN and HANDLED, with the
  count of open reports on the tab itself. Settled reports are kept rather than
  aged out. See below.
- **Clans** — every clan with its owner, roster and outstanding invitations.
  **Verifying** one turns its tag gold everywhere a nickname is drawn, and that
  is all verification does — which is why it is a judgement call rather than a
  process. A clan's picture can be taken away on its own, and a clan can be
  disbanded outright, which strips the tag from every member on the spot,
  including anyone mid-match.
- **Logs** — the server's log ring buffer (filterable by level, auto-refreshing)
  next to an audit trail of every change an administrator has made.

### The stats tab

One filter row at the top, one request behind it, and every card on the page
drawn from the same window — a dashboard that painted itself in fourteen stages
would be showing fourteen different moments, and two figures that disagree are
worse than no figures.

| Section | What it answers |
| --- | --- |
| **Right now** | Eight tiles with sparklines: players, rooms, free seats, peak, matches, new accounts, kills, tick cost |
| **Who is here** | Signed-in vs guests vs spectators vs bots over time; rooms open and how many of them demand opened; free seats |
| **What they did** | Kills, headshots and deaths per interval; rounds fired; matches finished |
| **Accounts** | New accounts a day, sign-ins a day, and distinct accounts that finished a match a day |
| **Retention** | Of every account ever made: how many played at all, how many came back on a later day, how many are holding a streak |
| **The ladder** | The level distribution in bands of five, and the GR economy beside it |
| **What gets played** | Map mix, mode mix, and class pick rate with win rate and K/D on every row |
| **When, and how it held** | Matches by hour of day (UTC), tick cost against its 16.7 ms budget, memory |
| **The journal** | Every kind of event in the window, and the raw event log newest first |

**Two tables feed it, and the split between them is the design.** `metrics` is a
regular sample of things that are *true right now* — players online, rooms up,
tick cost — written by one timer every `METRICS_INTERVAL_SEC` and never by
gameplay, so a busy match costs it nothing. `events` is the opposite: things that
*happened once* — a sign-up, a level crossed, a match ending, a ban. Nothing at
kill rate goes in `events`; a row per kill is a row per second per player and
buys no answer that a counter does not, so the rooms count those into plain
integers and the sampler drains them into one row per interval. Both age out
after `METRICS_KEEP_DAYS`.

The charts are hand-rolled SVG in `client/admin/charts.js` — the panel is served
from this machine to this machine and loads no third-party anything, the same
reason there is no webfont. They follow one set of rules: one axis ever (never
two y-scales), a fixed eight-slot categorical palette validated for colour-blind
separation and for contrast against the panel's own surface, the panel's semantic
colours (amber "you", green fine, red sanction) held out of it entirely, text in
text tokens rather than the data colour, and a hover layer on every chart —
a crosshair that reads out every series at once on a line, per-mark tooltips on
bars and arcs.

### Working the report queue

Two tabs, because "has anybody dealt with this" is the only question being asked
when the queue is opened:

- **OPEN** — the to-do list, read oldest-first: the oldest unanswered report is
  the one somebody has been waiting on longest.
- **HANDLED** — everything settled, whichever way it went, read newest-first,
  with a verdict filter for narrowing it to `actioned` or `rejected`.

Both tabs carry their own size, so how much is waiting never takes a click to
find out. Settled reports are **kept**: they used to be deleted on a ninety-day
timer, which threw away exactly what anybody wants when the same name turns up
again. `REPORTS_KEEP_RESOLVED_DAYS` can put a horizon back if an operator wants
one; open reports were never pruned and still are not.

Reports filed by the [anti-cheat](#the-anti-cheat) land in the same queue, under
the reporter name `anti-cheat` and marked **AUTOMATIC**. Nothing it catches
results in a ban without a person reading them first, so they are written as a
page rather than as a log line: what was refused in plain words, what a cheat
doing it would have been buying, whether a bad connection can produce it at all,
when each kind started and stopped, the first *and* the last piece of evidence
for each — and the worst ping and jitter the server measured while it was
happening, because "was this player lagging" is the question that settles most
of them. The body is rendered in a monospace column, since the layout is
carrying the structure.

Selecting a report shows everything needed to settle it without leaving the pane:

- **Who was reported** — their picture, level, K/D, whether they are already
  banned, muted or online right now, and the address they played from (the only
  handle there is on a reported guest, who has no account at all).
- **Why it was filed** — the reporter's own words, or the anti-cheat's page —
  and **the chat as it stood** when they filed —
  the last 25 lines of that match, kept because the match's own log is dropped
  the moment it ends. The reported player's lines are picked out in red.
- **Everything else filed about the same player**, so a pattern is visible
  without a second search.

`MUTE` and `BAN` act on the reported account straight from the report, using the
report itself as their reason. They deliberately do *not* close it: settling the
report is a separate, explicit step, because "I acted" and "I told the reporter
what happened" are two different things.

Closing it asks for an **action** (`none` · `warned` · `muted` · `banned`) and
one line **to the reporter**. That line is the only thing they ever hear back —
never who settled it, never the length of the sanction — and it appears under
**ACCOUNT ▸ REPORTS** in their menu. A report can be reopened, or deleted
outright, in which case the reporter never hears anything at all.

### What a ban does

A ban lands on the account **and**, unless you clear the checkbox, on every
address that account plays from — the one on its row plus any it is connected
from right now. It takes effect immediately, in this order:

1. Everyone the ban covers gets a red line in their match's chat naming the ban
   and its reason, so the room sees what happened.
2. The banned player is shown a full-screen ban card — scope, reason, expiry, a
   reference to quote and where to appeal (`BAN_APPEAL_CONTACT`) — and their
   socket is closed.
3. Every later attempt is refused server-side: the WebSocket handshake, the
   login endpoint and registration all check the account and the address before
   anything else happens. There is no client-side check to bypass.

Lifting the ban also lifts the address bans it created, so an appeal never
leaves someone locked out by a leftover row. Timed address bans expire on their
own and are swept hourly.

### Banning a guest

Guests have no account, which used to mean the panel could not see them: the
players table is a view of the users table, and the one player a moderator most
often has to remove was never in it.

A connected guest is now **a row on the players list for exactly as long as
their socket is open**, pinned above the accounts in every sort order, marked
`GUEST`, and searchable by the name the server assigned them. Nothing about it
is stored — the row *is* the connection — so it carries the two things that
exist: where they are playing from, and what they have done in the match they
are in.

Opening one gives a short panel, because there is nothing to edit. No level, no
password, no clan, no history, and no chat ban (a guest cannot write into the
chat in the first place). What it offers is:

- **KICK FROM MATCH** — closes the socket. They can come straight back.
- **BAN ADDRESS** — writes an IP ban for the address they are playing from,
  timed or permanent, and drops everyone connected from it. The guest's assigned
  name is stored on the row so the **IP bans** list can say who it was, but no
  account is claimed for somebody who never had one.

That second one is the whole point: a ban has to outlive the socket, and an
address is the only thing about a guest that does. Everything after it is the
ordinary address-ban path — the room is told, the ban card goes up, the socket
closes, and every later handshake from that address is refused. Lift it from
the **IP bans** tab, not from the guest's row: the row disappears with the
connection the ban just closed.

### What a chat ban does

Nothing except close the chat. A muted player keeps their seat, their score and
their match; their messages are refused and only *they* are told why. The ban
lands on the room they are in the moment it is issued — a red line naming who
issued it, and the `MUTED` chip on everyone's scoreboard — and it is read back
out of the database on their next handshake, so a reconnect does not clear it.
Timed mutes expire on their own and are swept hourly alongside the address bans.

Three things keep the panel off the internet: nginx 404s both paths, the listener
only answers loopback and RFC1918 addresses, and any request carrying proxy headers
(`X-Forwarded-For`, `X-Real-IP`, …) is refused because it cannot have come from
this network directly. Sessions are in-memory bearer tokens that die with the
process, and five wrong passwords lock an address out for a minute.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `port 7420 is already in use` | `sudo systemctl stop open-grunker`, or set `PORT` in `.env` |
| Site 502s | Server is down: `journalctl -u open-grunker -n 50` |
| Game loads but never connects | Check `/ws` proxying: `nginx -t`, and that `$connection_upgrade` is mapped in `nginx.conf` |
| `SQLite is an experimental feature` warning | Run through `npm start` or `scripts/db-cli.js`; both pass `--disable-warning=ExperimentalWarning` |
| Nothing renders, black screen | The browser needs WebGL — enable hardware acceleration |
| An edit to `client/` or `shared/` changes nothing | The build is being served, not the sources: `npm run build`, or `CLIENT_DIR=client` for a loop with no build in it |
| Players desync a moment after joining | Same cause: a client built before the last change to `shared/`. The boot banner names the file |
| Bots but no other humans | Expected on a quiet server; bots step aside as real players arrive |
| Admin panel says `local_only` | The request reached it through a proxy, or from outside this network — open it directly on `ADMIN_PORT` |
| Admin panel 404s | `ADMIN_PASSWORD` is empty in `.env`, or `ADMIN_ENABLED=false` |

---

## License

MIT — see [LICENSE](LICENSE). Open Grunker is an independent, from-scratch
project inspired by the arena-shooter genre. It is not affiliated with,
endorsed by, or derived from the code or assets of Krunker.io.
