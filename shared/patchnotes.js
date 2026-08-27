/**
 * Open Grunker — the build, and what changed in it.
 *
 * Loaded byte-identically by the server (which publishes the version through
 * `/meta`) and by the browser (which draws the newest entry in the menu and the
 * whole list behind it). Keeping the notes here rather than in the markup means
 * one place to edit when something ships, and the menu, the API and the README
 * cannot drift apart.
 *
 * Newest first. `kind` is one of:
 *
 *   new      something that was not there before
 *   change   something that worked differently before
 *   fix      something that was broken
 *
 * Write each line for the person who plays the game, not for the person who
 * wrote it: what they can now do, or what stopped going wrong.
 */

export const GAME_VERSION = '1.8.0';

export const PATCH_KINDS = {
  new: { label: 'NEW', color: '#4ddb7a' },
  change: { label: 'CHANGED', color: '#f5a623' },
  fix: { label: 'FIXED', color: '#4d9bff' },
};

export const PATCH_NOTES = [
  {
    version: '1.8.0',
    date: '2026-08-27',
    title: 'A faster frame everywhere, a profile card worth opening, and guests you can moderate',
    changes: [
      { kind: 'change', text: 'The game runs faster and looks exactly the same. Nothing was turned down: no draw distance was shortened, no effect was cut and no texture got smaller. What went away is work that produced no pixels \u2014 the shadow map redrawing the entire level from the sun on every single frame, and the sky being painted across the whole screen before the town was painted on top of it.' },
      { kind: 'change', text: 'Weapons and hands are drawn in a handful of pieces instead of sixty. Every part of a gun that never moves is welded together when the gun is built, and eight players carrying the same rifle share one copy of it rather than uploading eight. The magazine, the bolt and the cylinder are still their own pieces, because the reload moves them.' },
      { kind: 'change', text: 'Turning an effect off now actually turns it off. Chromatic aberration and film grain were still being computed and multiplied by zero, and with the bloom slider at zero three whole render passes were running to produce nothing.' },
      { kind: 'change', text: 'The interface no longer frosts the game behind it. That blur was a second, hidden render of whatever was behind every HUD panel and every killfeed line, sixty times a second, for the length of every match. The panels are a shade darker instead, so a white health number is still readable against a white house.' },
      { kind: 'change', text: 'Bodies standing behind you are no longer animated, and the menu stops drawing the match behind it at full speed while a settings panel or a window is covering it.' },
      { kind: 'change', text: 'The profile card reads across instead of down. Picture, name, clan tag and level along one band with your K/D, kills and wins beside them, then your career and your last six matches side by side. It used to be a narrow strip you had to scroll to the bottom of.' },
      { kind: 'new', text: 'Guests can be moderated. Anybody playing without an account now appears at the top of the admin panel\u2019s player list for as long as they are connected \u2014 with the room they are in and what they have done in it \u2014 and can be kicked, or banned by address, which is the only kind of ban that outlives somebody who has no account to ban.' },
    ],
  },
  {
    version: '1.7.0',
    date: '2026-08-27',
    title: 'Weapons you can actually look at, skins that are worth owning, and hands that hold the gun',
    changes: [
      { kind: 'change', text: 'Every weapon has been rebuilt. Slide serrations, ejection ports, charging handles, vented handguards, curved magazines, scope turrets, belt drums with brass coming out of them, a knife with a spine and a bevelled edge — roughly three times the detail on all eleven, and each one now reads as the gun it is meant to be rather than a stack of boxes.' },
      { kind: 'change', text: 'The arms and hands are new. Two forearms, sleeves, cuffs, bare wrists and gloves with four fingers, a thumb and an index finger laid on the trigger. They are placed on each weapon’s own grips, so the fingers land on the actual grip and the support hand holds the actual handguard — or the pump, or the foregrip, or the butt of a pistol.' },
      { kind: 'fix', text: 'The gun no longer disappears into the camera. A rifle’s butt stock used to sit behind your eye, which is why it was invisible, and anything that reached the near plane smeared across the screen. Every weapon is now framed for its own length: a rifle sits into the shoulder, a pistol is held out and higher, and the knife is turned so you can see the blade.' },
      { kind: 'change', text: 'Skins are not tints any more. A finish now paints the gun by zone — receiver, working steel, furniture, hardware — so Gold Rush gilds the receiver and leaves the butt pad black rubber, and Carbon Fibre weaves the furniture and leaves the barrel blued. No finish ever touches a lens, a reticle or a tritium dot, so a gold rifle still has glass in its optic.' },
      { kind: 'new', text: 'Every finish has a real pattern: pixel camouflage, splinter, four-tone woodland, sand-blasted wear, acid splatter, racing stripes, carbon weave, engraved scroll, folded damascus steel, glowing circuit traces, a stencilled issue number. All sixteen are painted on your own machine at load time — nothing extra is downloaded.' },
      { kind: 'new', text: 'Your finish is on your gloves too, in first person and in third. A skin is something you wear as well as something you carry.' },
      { kind: 'fix', text: 'Everybody else sees the finish you actually equipped. Third-person weapons were always factory grey, and changing class did not change the skin with it.' },
      { kind: 'fix', text: 'Reloading a pistol no longer pulls the grip off the gun. The grip and the magazine were the same box; they are two things now, and only one of them leaves.' },
      { kind: 'new', text: 'God mode, for administrators. There is a switch in the scoreboard’s footer: nothing can hurt you, and SPACE and CTRL fly you up and down while the crosshair steers. Walls still stop you. It lasts as long as the connection, is re-checked on every press, and both directions are written to the admin log.' },
    ],
  },
  {
    version: '1.6.0',
    date: '2026-08-25',
    title: 'Two-factor authentication, a career worth having, weekly challenges — and a server that stops running matches nobody is in',
    changes: [
      { kind: 'new', text: 'Two-factor authentication. Turn it on under ACCOUNT \u25b8 SECURITY, scan the code with any authenticator app, and signing in asks for six digits as well as your password. Ten single-use recovery codes come with it for the day the phone is gone. The QR code is drawn on your own machine \u2014 nothing about your secret is ever sent anywhere to make a picture of it.' },
      { kind: 'new', text: 'Career milestones. Twenty-one lifetime goals \u2014 kills, wins, headshots, matches, killstreaks, damage, hours \u2014 each paid once, each worth real GR and XP. The first few land on your first evening; the last ones are years away. They are on the CHALLENGES tab, closest first, and they are named on the end-of-match card when you cross one.' },
      { kind: 'new', text: 'Weekly challenges. Three a week alongside the three a day, resetting Monday morning and worth several evenings each. A daily is gone by morning whether or not you finished it, which makes it useless if you play twice a week; a week\u2019s progress is still there when you come back.' },
      { kind: 'change', text: 'Levelling is much slower, right across the ladder. A match pays its score back as XP one for one and a good round is a couple of thousand points \u2014 which put level 10 inside two matches and level 50 inside a hundred. Level 10 is now an evening, level 30 is weeks and level 50 is a long way past that. Nobody lost a level they had already earned: every account was topped up to exactly what the level on its card now costs. Levels pay about three times as much GR to match.' },
      { kind: 'change', text: 'The server stops simulating rooms nobody is in. A quiet night used to run every room\u2019s clock anyway \u2014 rotating maps every four minutes and writing a match record every time \u2014 so most of the match history was rounds that nobody played. Rooms now sleep until somebody walks in and go back to sleep behind the last person out. They are still listed and still joinable.' },
      { kind: 'change', text: 'Matches with no players in them do not count. Nothing empty is recorded, paid out or graphed, so \u201cmatches played\u201d finally means matches that were played.' },
      { kind: 'change', text: 'The room list scales against the number of people actually here, not against the ceiling. A brief rush can no longer leave a quiet server carrying a dozen rooms.' },
      { kind: 'fix', text: 'The ammo panel in the bottom-right corner stops changing size. Reloading used to make it jump a line taller and 150 pixels wider, then jump back when the reload finished.' },
      { kind: 'fix', text: 'The interface no longer falls apart in spectator mode. The health panel jumped out of its corner and landed on top of the match clock the moment you started watching, the spectator bar ran off both edges of a narrow window, and with nobody alive to watch the screen turned red as though you were dying.' },
      { kind: 'fix', text: 'Your clan tag is on your account card in the top-left of the menu. It was drawn everywhere else and missing there.' },
      { kind: 'fix', text: 'A verified clan is gold in the admin panel\u2019s player list, the way it is everywhere else.' },
      { kind: 'change', text: 'The admin panel\u2019s STATS tab is readable. Seventeen charts in one undifferentiated column, each row a different width from the row above it, is now six named sections on one four-column grid \u2014 so every card lines up with every other card, and you can find the thing you came for.' },
      { kind: 'change', text: 'The STATS tab counts rooms that have somebody in them, rather than rooms that exist.' },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-08-25',
    title: 'A bug-fix pass on nearly everything you touch — plus a nuke, and a spectator mode worth watching',
    changes: [
      { kind: 'fix', text: 'Players are no longer invisible. A body that finished its death animation stayed at zero opacity when it respawned, and its weapon — which never faded in the first place — did not, so the player came back as a rifle walking around on its own. Everything the death touches is now put back when the player comes back.' },
      { kind: 'fix', text: 'Everyone now sees the weapon you are actually holding. Switching to the sidearm or the knife changed nothing anybody else could see: only the primary was ever built on a third-person body, so you killed people with a rifle you were not carrying.' },
      { kind: 'fix', text: 'Aiming is on the right mouse button. It was on the middle one — the button table had the codes crossed, so the panel said RMB while the game listened to the wheel click.' },
      { kind: 'fix', text: 'Rockets do damage again when they hit the scenery. The blast went off exactly *on* the surface it touched, so the check for who was in it started inside that wall and reported everybody as covered — a direct hit on the wall a foot behind someone did nothing at all. Rocket jumping was the same bug: firing at your own feet detonated on the floor and the blast never reached you. Both work now.' },
      { kind: 'fix', text: 'Tree canopies, hedges, bushes, benches and fence posts are solid. Running through a mass of leaves was the loudest thing wrong with these maps. Trees stop bullets now too, so a tree between you and a sniper is cover.' },
      { kind: 'change', text: 'Bunny hopping and sliding are things you do rather than keys you lean on. Holding jump used to hop on every landing and holding crouch used to re-slide the moment the cooldown ended; both now need a fresh press. The early-press and late-press grace windows are untouched, so a hop timed a few frames out still lands — what went away is the repeat.' },
      { kind: 'change', text: 'You respawn on your own. The timer runs down and you are back in — no key to press. Press ESC in the seconds before it lands and you stay down for as long as you want; closing the menu puts you back in.' },
      { kind: 'change', text: 'The sniper is a scoped weapon now. Hip-fire went from a three-degree cone to a genuinely wild one, so the rifle that deletes anyone it touches has to be aimed to touch them.' },
      { kind: 'change', text: 'The starting pistol is a fallback again rather than a primary. Slightly less damage, a slower trigger, a wider cone and much less reach — a point-blank four-tap still kills, and anything further out no longer does.' },
      { kind: 'new', text: 'The nuke. Twelve kills without dying arms it; press the key and the whole room gets a seven-second warning to come and find you. Survive it and everybody on the other side dies where they stand and the match is yours. Kill the caller and it goes with them — that is the only counterplay there is, and it is why it is announced rather than simply happening.' },
      { kind: 'new', text: 'Spectating is a real mode. You get the whole interface, drawn from the player you are watching: their health, their weapon and magazine, their class, their crosshair, the minimap from where they are standing, plus the killfeed, the scoreboard and the chat. Press V for a chase camera and X to see everybody through the walls.' },
      { kind: 'new', text: 'A proper knife animation, first and third person — the blade cocks back, crosses the screen and settles, instead of the screen jolting.' },
      { kind: 'new', text: 'A proper death animation. Legs buckle, the body rolls off the line it was shot along, the weapon leaves the hands and drops, the body settles flat for a beat and only then fades. No two bodies land the same way, and everybody watching sees the same fall.' },
      { kind: 'new', text: 'Double-click any number in the settings and type the value you want. Sliders are the wrong instrument for "1.37 exactly".' },
      { kind: 'new', text: 'Export and import your settings as a file, key bindings included — no account needed. Settings were always saved in your browser; signing in only copies them between devices, and the panel now says so.' },
      { kind: 'new', text: 'A mouse acceleration switch, under SETTINGS ▸ AIM. Off (the default) asks the browser for raw input, so the same flick is always the same number of degrees.' },
      { kind: 'new', text: 'An option to hide your weapon while aiming, under SETTINGS ▸ WEAPON. Yours only — everyone else still sees you holding it.' },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-08-24',
    title: 'Controllers, a room list that grows with the crowd, a ladder that means something, and a much faster frame',
    changes: [
      { kind: 'new', text: 'Full controller support. Plug a pad in and it just works — left stick moves, right stick looks, triggers fire and aim, and the whole layout is rebindable in its own column under CONTROLS. START opens the menu, and in the menu the stick moves the highlight, A presses and B goes back, so you never have to reach for a mouse to press PLAY.' },
      { kind: 'new', text: 'Aim assist for controllers, and only the honest kind: the look stick slows down while your crosshair is already on someone. Nothing is ever pulled toward a target. It is a slider in SETTINGS ▸ CONTROLLER, along with stick speed, deadzone, response curve and vibration.' },
      { kind: 'new', text: 'The room list now grows and shrinks with the number of people playing. A mode that is running out of seats gets another room within seconds; a room that has been empty for two minutes closes again. Nobody sees "every room is full" while the machine is idle, and nobody lands alone in one of eight empty matches on a quiet night.' },
      { kind: 'change', text: 'Levelling gets harder the higher you go. The first ten levels cost exactly what they always did — everything down there, including the chat at 2 and clans at 5, arrives on the same evening it used to. Past that the curve steepens hard: level 30 is about twice the old figure and level 100 about eight times it. Nobody lost a level they had already earned; accounts above the ramp were topped up so the number on their card still means what it meant.' },
      { kind: 'new', text: 'Every level you cross now pays GR on the spot, and it pays more the higher up the ladder it is. It is announced on the end-of-match card as its own line rather than folded into the match figure.' },
      { kind: 'new', text: 'Signing up finally pays what the button has been promising: 500 GR, the Enlisted weapon finish, and the whole list is itemised on the sign-up card. Accounts that already existed were granted the finish too.' },
      { kind: 'new', text: 'A guest who finishes a match is now shown exactly what it would have been worth to an account — the real number, from the same arithmetic — instead of a slogan.' },
      { kind: 'change', text: 'The end-of-match card now says what tomorrow is worth: the next day of your play streak, and what it pays. The streak panel has always known; nothing ever said it at the moment you were deciding whether to play one more.' },
      { kind: 'change', text: 'A big pass over the frame rate, with nothing given up to get it. The minimap stopped redrawing a thousand walls every frame and now blits one baked image; the HUD stopped writing thirty DOM properties per frame and now writes only what changed; every character in the game shares one set of box geometry instead of rebuilding thirty-one buffers on every join and every class change; and fifteen parts whose shadow was already inside somebody else\u2019s came out of the shadow pass.' },
      { kind: 'change', text: 'The server got the same treatment. A snapshot is now serialised once per room instead of once per player, the roster is no longer rebuilt twenty times a second, and the lag-compensation history stopped allocating an object per player per tick.' },
      { kind: 'new', text: 'A STATS tab in the admin panel: population, rooms, combat, sign-ups, retention, the level distribution, map and mode and class mix, the busiest hours, tick cost and memory — all of it over any window from six hours to ninety days, and all of it drawn from a new sampler that writes one row per interval rather than one per kill.' },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-08-24',
    title: 'A whole new town, invisible walls instead of real ones, and a reason to come back tomorrow',
    changes: [
      { kind: 'new', text: 'Littletown. A suburban crossroads with a planted island in the middle, four blocks of painted houses behind garden fences, a chapel with a clock tower, a park with a pond, and a plank run between two shop roofs straight over the main street. It is the new default map.' },
      { kind: 'change', text: 'Every map has been rebuilt from scratch. Burgtown is a cobbled market square under a clock tower; Crossfire is a half-built street on scaffolding; Sandstorm is a whitewashed desert town; Shipyard is a working harbour with the sea down one side; Subzero is an alpine village around a frozen pond. The practice range got a lawn.' },
      { kind: 'change', text: 'The fourteen-metre concrete walls around every map are gone. The edge of the playable area is now an invisible boundary, and past it the town simply keeps going — more roofs, a treeline, hills. You can see out of a map for the first time.' },
      { kind: 'new', text: 'Maps are full of things that are not walls: parked cars and box trucks you take cover behind, hedges, lamp posts, power lines, market stalls, billboards, benches, planters, trees you can run through the edge of. Anything that is only dressing never eats a bullet and never takes a corner off a fight.' },
      { kind: 'change', text: 'New surface art across the board — road, lawn, hedge, fence board, house cladding, glazed windows, shingles, bark, water, awning canvas, pavement. Materials now carry the pattern and maps carry the colour, which is what lets a town be bright and saturated instead of grey.' },
      { kind: 'change', text: 'The sky is a real sky: cloudless blue over Littletown, fat cumulus over Burgtown, and a horizon you can see all the way to instead of a wall thirty metres away.' },
      { kind: 'new', text: 'A daily play streak. Finish one match a day and you take a bonus that climbs every day for a week; miss a day and it starts again. There is a first-win-of-the-day bonus on top. Both are on your PROGRESSION tab, and both are paid for playing rather than for opening the menu.' },
      { kind: 'change', text: 'The interface has been softened all the way through: rounded cards, real shadows, capsule bars, buttons that press back, and a glass panel behind the health and ammo readouts so they stay legible over a white house in full sun.' },
      { kind: 'change', text: 'The admin panel has been completely redrawn — heavy type, big numbers, rounded slabs, and a proper name at the top of every page.' },
      { kind: 'change', text: 'Account, clan, match and report ids are now UUIDs instead of a counter. Existing accounts keep everything — their stats, their clan, their picture and their session — and simply take a new id on the first boot after the update.' },
      { kind: 'change', text: 'Joining a match no longer downloads the level. The client builds it from the same code the server collides against, so a map is an id on the wire rather than a hundred kilobytes of boxes.' },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-08-24',
    title: 'Momentum that follows your crosshair, spectator mode, and a much bigger rocket',
    changes: [
      { kind: 'fix', text: 'The REPORT and mute buttons on the scoreboard did nothing at all. The board was being rebuilt on every frame it was open, which deleted the button between pressing it and letting go — so the click never landed. It is now redrawn only when something on it actually changed, and never while you are pressing it.' },
      { kind: 'new', text: 'Spectator mode. A switch above the build chip in the menu, and on the pause card: turn it on and you watch another player through their own eyes. Flip it mid-match and it takes over at your next death; flip it while you are not spawned and it starts straight away. A and D, the arrow keys, the wheel or a click move to the next player, and the camera moves on by itself when the one you are watching dies or leaves. The switch greys out in an empty match — there is no point of view to borrow.' },
      { kind: 'new', text: 'A PROGRESSION tab in your account panel: the whole ladder in one place, what each level unlocks, and how much XP is left to the next one.' },
      { kind: 'change', text: 'XP is now your match score, one for one. Score 3204 points and you finish the match 3204 XP better off — no separate formula that disagreed with the number you watched climb all match.' },
      { kind: 'change', text: 'Reporting now opens at level 5 rather than level 2. A bad chat line costs one person one line; a bad report costs a moderator the time of every real report it buried.' },
      { kind: 'change', text: 'A refused REPORT button is now drawn greyed out with the reason on it instead of disappearing — hover it to read why, whether that is a level, a cooldown, or a moderator having switched reporting off for your account.' },
      { kind: 'new', text: 'Moderators can switch reporting off for one account without touching anything else: they keep playing and keep talking, they simply cannot file. The reason travels with it and is on the button they find greyed.' },
      { kind: 'change', text: 'Reaching level 2 unlocks the chat there and then. It used to need a page reload before the game would let you type.' },
      { kind: 'change', text: 'The Rocketeer hits far harder. The RPG reloads in 1.15s instead of 2.3, the rocket flies faster, and the blast has gone from 5.4 to 7.6 units — a direct hit kills outright and the edge of it still hurts. Rocket jumps cost less than they used to, so the height is still worth taking.' },
      { kind: 'fix', text: 'Rockets left their warhead hanging in the air at the point of impact after exploding, for the rest of the match.' },
      { kind: 'change', text: 'Momentum now follows your crosshair. Hopping or sliding with no strafe key held, your speed turns to point wherever you are aiming — a slide carves hard, a hop about half as hard — and it costs nothing: you carry every unit of speed you earned through the turn. Sliding round a corner is a matter of looking round it.' },
      { kind: 'change', text: 'Holding A or D takes the wheel back and gives you the classic air-strafe, untouched. The two take turns on purpose: strafe speed comes from the angle between where you are going and where you are pushing, and steering exists to close exactly that angle, so layering them would have quietly halved the fastest thing in the game.' },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-08-22',
    title: 'Clans, profiles, and a scoreboard you can click',
    changes: [
      { kind: 'new', text: 'Clans. A tag of up to four characters worn in front of your name everywhere it appears — grey, or gold once the developers have verified the clan.' },
      { kind: 'new', text: 'Found a clan at level 15 for 1000 GR, or join one at level 5. Clans are invite-only: the owner invites, removes, hands the clan over, sets its picture or disbands it.' },
      { kind: 'new', text: 'Every nickname in the game opens that player’s profile — on the scoreboard, in the chat, on the end-of-match card, on the leaderboard and in a clan roster.' },
      { kind: 'fix', text: 'The scoreboard’s buttons were dead to every click. The whole HUD was refusing pointer events, so mute and report could never be pressed at all.' },
      { kind: 'change', text: 'The scoreboard key now pins the board open and hands the mouse back instead of showing it only while held. Press it again, or Escape, to close.' },
      { kind: 'change', text: 'Reporting gained five more ceilings: a flat cooldown, a daily cap, a limit on reports a moderator has not read yet, and a lockout for reports that keep being dismissed. None of them is a punishment — every one clears on its own.' },
      { kind: 'change', text: 'The nickname box and the sign-in line have left the menu. Your account chip in the top-left already carries both, and this space now carries the build you are playing.' },
      { kind: 'change', text: 'Server population and account totals are staff-only now.' },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-08-20',
    title: 'First release',
    changes: [
      { kind: 'new', text: 'Nine classes, six maps and five modes: free for all, team deathmatch, gun game, domination and a practice range.' },
      { kind: 'new', text: 'Bunny-hopping, crouch-sliding, air-strafing and quickscoping, simulated identically on the client and the server.' },
      { kind: 'new', text: 'Accounts with XP, levels, GR, weapon mastery, daily challenges, skins and profile pictures.' },
      { kind: 'new', text: 'Shareable match codes: send someone your link and they land in the same match.' },
      { kind: 'new', text: 'Moderation from the scoreboard, player reports with a verdict you read back, and a private admin panel.' },
    ],
  },
];

/** The build being played right now. */
export const latestPatch = () => PATCH_NOTES[0];

export default { GAME_VERSION, PATCH_NOTES, PATCH_KINDS, latestPatch };
