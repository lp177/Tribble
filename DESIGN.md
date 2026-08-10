# Tribble — Design Document

Tribble is a browser game mixing **Tetris** and a **bubble shooter**. You aim a launcher at the
**top** of the screen and fire tetromino pieces **downward** onto a stack that slowly grows up
from the bottom. Clear cells by completing full horizontal lines (Tetris) or by connecting 3+
blocks of the same color (bubble-shooter / Puyo style). If the stack reaches the launcher zone,
you lose. A P2P versus mode adds power bubbles and curses you send to your opponent.

Tech: TypeScript + Vite, single HTML page, one `<canvas>` for the game, DOM for menus/HUD.
No external assets: all sound is procedural WebAudio, all graphics are canvas drawing.
Deployed as a static build committed to `docs/` (GitHub Pages). PeerJS (public cloud broker)
provides WebRTC signaling for versus mode.

**The single source of truth for all cross-module types, constants and interfaces is
`src/types.ts`. Read it before implementing anything. Implement the exact exports listed in
"Module contracts" below — other modules are being written in parallel against those
signatures.**

## Coordinate system

- Board grid: `COLS = 11` columns × `ROWS = 20` rows. `grid[row][col]`, **row 0 at the top**,
  row `ROWS-1` at the bottom. A cell is `CellColor (0..3)` or `null`.
- The top `TOP_KILL_ROW = 3` rows are the launcher zone: if any settled cell ends up in a row
  `< TOP_KILL_ROW` (after lock, gravity or rise), the game is over.
- Continuous positions (flying piece, aim path, power bubbles) use **cell units** in the same
  frame: x ∈ [0, COLS], y ∈ [0, ROWS], y grows downward. Cell (row, col) has its center at
  x = col + 0.5, y = row + 0.5.
- The launcher sits at `LAUNCH_X = COLS / 2` (= 5.5), `LAUNCH_Y = 1.0`.
- The renderer maps cell units → pixels via `BoardMetrics` (origin + cellSize) and is the only
  place that knows about pixels for the board. Particles/UI effects work in **screen pixels**;
  `main.ts` converts using `Renderer.boardMetrics()`.

## Pieces

The 7 tetrominoes `I O T S Z J L`. Each piece has 4 blocks; each block has its own
`CellColor` (4-color palette). Colors are assigned as **two adjacent pairs** (2 blocks of
color A + 2 blocks of color B, A ≠ B chosen from the bag RNG), so a landed piece can complete
a color match with a single field block. Cell order inside a shape definition is chosen so
cells 0,1 are adjacent and cells 2,3 are adjacent (pairs stay glued in every rotation).

Rotation: 4 rotation states per shape, cells as integer offsets from a pivot; rotating
remaps offsets but preserves cell order (color i stays on cell i). No wall kicks are needed
while flying; rotation while aiming/flying always succeeds (the piece is in free air; if a
rotation would overlap a wall, clamp x so it fits).

Piece sequence: 7-bag randomizer fed by the dedicated `bagRng` stream so both players in
versus (same seed) get the same sequence regardless of local random events.

## Core loop (single player)

Phases: `aiming → flying → resolving → aiming …` (+ terminal `gameover`).

1. **Aiming.** The current piece is shown at the launcher. The player rotates it and aims:
   angle 0 = straight down, clamped to ±`MAX_AIM_ANGLE` (1.22 rad ≈ 70°). The aim path is a
   ray from the launcher that reflects off the side walls (like a bubble shooter) and stops
   where the piece would first collide. `computeAimPath` must use the same collision test as
   flight so the line is honest.
2. **Flying.** On launch the piece travels at `LAUNCH_SPEED = 26` cells/s along the aim
   direction (no gravity). It reflects off side walls (`bounce` event). The piece may still be
   rotated mid-flight (skill element). In versus, if any piece cell comes within
   `POWER_RADIUS = 0.6` cell units of a floating power bubble, the bubble is caught.
3. **Impact & lock.** When any block of the piece would overlap an occupied cell or the floor,
   step back to the last free position, snap the piece to the nearest free grid placement
   (never overwrite occupied cells, never out of bounds, resolve conflicts by backing off along
   the inverse velocity; must always terminate), then **settle**: slide the whole piece
   straight down until it rests. Write its blocks into the grid (`lock` event).
4. **Resolving.** Repeat until stable, with `RESOLVE_STEP = 0.22`s between iterations so
   cascades are readable:
   - Full rows → line clear. Connected same-color groups of `MATCH_MIN = 3`+ → color match
     clear. Both can happen in one step; all are removed simultaneously (`clear` event).
   - Per-cell gravity (Puyo-style): every block falls straight down into the lowest free cell
     below it. If any clear happened after a fall, it is a **chain** (`chainStep` event,
     multiplier ×2 per chain, capped ×32).
   - When nothing clears, resolution ends; check kill condition; back to aiming with the next
     bag piece.
5. **Rising stack.** `riseTimer` counts down (paused while resolving); at 0 a garbage row is
   inserted at the bottom (random colors, 2–3 holes from `miscRng`), pushing everything up
   one row (`rise` event; `riseWarning` fires 1.5 s before). The interval decays towards a
   floor **and** tightens with the player's level, so pressure comes from progress as well as
   from the clock:
   `base = riseMin + (riseStart − riseMin) · exp(−elapsed / riseTau)`
   `riseInterval = max(RISE_FLOOR, base · riseLevelFactor^(level − 1))`
   All four numbers come from the active `DifficultyConfig`; the game starts with
   `cfg.initialRows` garbage rows.

## Difficulty and hazards

`DIFFICULTIES` (types.ts) defines four tiers — **chill / normal / hard / hardcore** — each
carrying its own rise curve, starting rows, `clearsPerLevel`, hazard cadence, armour chance and
`scoreScale`. The tier is chosen on the title screen, stored in `Settings.difficulty`, passed
to `createGame` and recorded in the save so a resumed run keeps its rules. Versus always plays
'normal' so both peers share the same tuning.

**Hardcore** sets `stoneOnly` (colour matching is skipped entirely — `state.colorsLocked` is
permanently true, so only line clears exist) and `aimGuide: false`, which makes main.ts pass
`aimPath: null`. Blocks keep their stored colours; the renderer simply paints everything with
`STONE_HEX`, so matching resumes correctly when a temporary lock ends.

**Hazards** are solo-only variety (versus has curses instead). When `cfg.hazardEvery > 0` a
timer rolls one hazard at a time, never repeating back-to-back: `stone` (colorsLocked for 14 s),
`armor` (dealt pieces land armoured), `giant` (pieces come from `BIG_PIECE_KINDS`, the
pentominoes, drawn off `miscRng` so the 7-bag stream stays deterministic) and `rush` (the rise
timer ticks twice as fast, composing with the versus `speed` curse). `hazardStart`/`hazardEnd`
drive the renderer's intro banner, the HUD countdown and a music takeover.

**Armour** lives in `state.armor`, a `ROWS × COLS` grid parallel to `state.grid` that must move
in lockstep with it everywhere a cell moves or dies. A clear that would remove an armoured cell
decrements it and keeps the block (`armorHit`); only cells at armour 0 disappear. The critical
invariant: a resolve step where **nothing actually disappeared** must end the cascade — armour
damage alone must not keep it alive, or an all-armoured board loops forever.

Scoring: color match = `40 × cells × chainMult`; line clear = `120 × n^1.5 × chainMult`
(n = simultaneous lines), rounded; `chainMult = 2^(chain−1)` capped at 32. A **combo** counter
(consecutive launches that cleared something) adds +10% per combo step. `clearsTotal` counts
each line and each match group; `level = 1 + floor(clearsTotal / 8)`; score gains scale by
`(1 + (level−1) × 0.1)`. `levelUp`, `score`, `danger` (stack within 4 rows of the kill zone)
events drive juice/music.

## Versus mode

Both players run **independent boards** with the same `seed` (same piece sequence). Opponent's
board is mirrored live as a mini-view. You win when the opponent tops out (or disconnects).

**Power bubbles:** in versus, each resolve step that cleared something has a
`0.30 + 0.10 × (chain−1)` chance (max one per resolve cycle, max `MAX_POWERS = 3` on board)
to spawn a power bubble at the centroid of the cleared cells. It carries a random `CurseKind`
and floats **upward** at 1.2 cells/s with a sine wobble. Catch it with your flying piece to
store it (`inventory`, max 3, FIFO). It despawns if it floats above row 1 (`powerLost`).

**Curses** (sent with the `useCurse` action, applied to the *opponent*):

| kind        | effect on the victim                                   | duration |
|-------------|--------------------------------------------------------|----------|
| `garbage`   | 2 garbage rows rise immediately                        | instant  |
| `speed`     | rise interval halved                                   | 15 s     |
| `fog`       | aim line hidden                                        | 12 s     |
| `scramble`  | 12 random filled cells get re-rolled colors            | instant  |
| `mirror`    | aim controls inverted (keyboard and mouse)             | 10 s     |
| `lockRotate`| rotation disabled                                      | 10 s     |

Curse handling lives in `core/game.ts` (`applyCurse` mutates state / `activeCurses`,
`update` ticks durations, emits `curseApplied` / `curseExpired`). Presentation reads
`state.activeCurses`: `fog` → main passes `fogged: true` to the renderer; `mirror` → main
inverts aim input. `useCurse()` pops the inventory and returns the kind; `main.ts` forwards it
over the network.

Networking: PeerJS. Host creates a peer with id `tribble-<CODE>` (`CODE` = 5 chars from
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`); guest connects to that id. Host picks
the seed and sends `start`. State snapshots (`state` msg, compact flat grid, −1 for empty)
are throttled to 5 Hz. Disconnect = win for the remaining player. Rematch via
request/accept with a fresh seed from the host. Messages are JSON (`NetMsg` in types.ts).

Timeouts are per phase (`waitFor` on the attempt context): 30 s to get connected, but an open
room waits 10 minutes for a friend — sharing a link means pasting it into a chat and waiting
for someone to look at their phone.

**Invites are links, not codes.** The host shares `<app-url>#r=<CODE>`; opening it joins that
room directly. `src/net/invite.ts` owns both the code format and the link format, so the two
can never drift apart. The code lives in the *fragment* on purpose: it never reaches the
server, so the link needs no routing rules on a static host and the service worker keeps
serving the same cached shell for it. `main.ts` consumes the link on load and on `hashchange`
(an installed app is handed the link without a reload), then strips it from the address bar
with `replaceState` so a reload cannot re-join a dead room. The reader accepts `#r=`,
`#room=`, `#join=`, a bare `#ABC23` and the `?`-query equivalents, so a link mangled in
transit still works; the code is still shown for reading out loud, and the join field pulls a
code out of anything pasted into it (a full link, or a link inside a chat message).

A shared link is only worth anything if the room outlives the sharing, so a host also
survives a guest that dies mid-handshake (that connection is released and the room reopens,
`onGuestFailed` reports it) and tries a bounded `peer.reconnect()` if the signalling socket
drops while waiting. `src/net/invite.test.ts` covers the link format; `scripts/smoke-invite.mjs`
drives the whole thing on real peers, including the failed-guest case.

## Save / resume

Single-player games auto-save (throttled ~5 s, plus `visibilitychange`→hidden and `pagehide`)
to `localStorage["tribble.save.v1"]`. The title menu shows **Resume** when a save exists.
Save cleared on game over / quit-to-title-with-abandon / new game. Settings (key bindings,
volumes, reduced-motion override, player name) live in `localStorage["tribble.settings.v1"]`.
Versus games are never saved.

## Game feel (juice) — this game must FEEL great

- **Screen shake**: impact (scaled by speed), line clear (bigger), rise (rumble), curse hit.
  Decaying amplitude + slight rotation; applied as canvas transform by the renderer.
- **Hit-stop**: 40 ms on multi-line clears, 60–90 ms on chains ≥ 2 (juice.timeScale → 0;
  main multiplies the sim dt).
- **Particles**: block shards in block color on every cleared cell; sparkle trail on the
  flying piece; catch burst on power bubbles; floating score text on clears.
- **Flash**: subtle full-board tint on chains / level up / curse received.
- **Danger state**: pulsing red vignette + faster music intensity.
- Every effect respects reduced motion (`Settings.reducedMotion`: `'auto'` follows
  `prefers-reduced-motion`; `'on'` forces reduced): no shake, no hit-stop, particle counts
  ~25%, flashes at low alpha. Sound is unaffected.
- Audio: procedural WebAudio SFX (launch swoosh, wall blip, impact thud, pop-cascade for
  matches with pitch rising per chain step, line-clear sweep, rise rumble, danger alarm,
  power sparkle, curse zap, game-over down-sweep, UI clicks) plus generative music.

**Music.** One lookahead scheduler renders every track from a `TrackConfig` (scale, chord
voicings, tempo, arp subdivision/density, pad & pluck timbres, filter, swing), so tracks are
data rather than code. Six base tracks in different modes/tempos; `startMusic()` picks one at
random (never repeating the previous), so runs don't all sound alike. `setIntensity(0..1)`
still modulates tempo and cutoff *within* the active track, following level and danger.

Dramatic pace changes take the music over: `pushMusicEvent(id, kind)` cross-fades to a
variation (`danger` tense and faster, `curse` darker and dissonant, `power` bright and
shimmering, `surge` a hotter version of what's playing) and remembers what was playing.
`popMusicEvent(id)` ends it, and when the stack empties the score cross-fades back to a
**re-rolled** base track rather than the old one. main.ts drives this: danger on/off, timed
curses applied/expired, holding vs. spending power bubbles, and a `shuffleMusic()` every few
levels as the rise speed ramps. Cross-fades duck the music bus and swap on a bar line, so a
swap never hard-cuts or leaves stale notes ringing.

## UI

Dark Material-inspired theme (see `src/style.css` tokens). Screens: **title** (logo, Resume
if save exists, New Game, Versus, Settings, How to play), **settings** (volume sliders,
reduced motion select, player name, key rebinding list — click a binding then press a key;
Escape cancels), **versus lobby** (Host → invite link with copy/share buttons plus the room
code as the spoken fallback; Join → link-or-code input; status line),
**paused** overlay, **game over** overlay (score, best score in `localStorage`, retry/menu),
**versus end** overlay (win/lose, rematch). Buttons have pointer-centered ripple (and a
centered ripple on keyboard activation), visible focus rings, hover/active states. The HUD
shows score, level, chain/combo toasts, next-piece preview, rise progress bar, curse
inventory (versus), opponent mini-board (drawn by the renderer) + name/score. `announce()`
mirrors important events to an `aria-live` region.

Default bindings (rebindable, stored as `KeyboardEvent.code`):
aim left `ArrowLeft`, aim right `ArrowRight`, rotate CW `ArrowUp`/`KeyX`, rotate CCW
`KeyZ`, launch `Space`, use curse `KeyC`, pause `Escape`. Mouse: move to aim, click to
launch, right-click or wheel-click rotate. Keyboard aiming: holding aim keys sweeps the
angle at `AIM_KEY_SPEED = 1.6` rad/s (main polls `isDown`).

## The AI opponent

Versus only ever talks to the opponent through `NetSession`, so the bot
**impersonates a peer** rather than being a special case: `createBotSession()`
returns a `NetSession` and `createVersus()` runs against it unmodified. Curses,
the opponent mini-board, win/lose and the rematch handshake all work for free.

`src/ai/bot-brain.ts` — `chooseMove(state, level, rng)`, pure and deterministic.
It does not clone a `Game` to evaluate a candidate: `computeAimPath()` reads only
the grid, the current piece and the aim angle, and its **last point is exactly
the resting pivot**, so the search asks the real engine where a shot lands (the
same invariant the aim-honesty test pins). It then resolves the clears on a
scratch grid and scores the result: reward cleared cells, lines (`n^1.5`) and
cascades; punish holes, aggregate height, bumpiness and max height; plus a
danger term **quadratic in the remaining headroom**, so it is nearly flat on a
low board and overwhelming near the kill line. A power-bubble bonus scaled by
`level.powerAppetite` steers shots through bubbles (suppressed when the
inventory is full, since the engine would drop the catch).

Levels differ in *play*, not in a post-hoc handicap: `angleSteps` candidates,
`blunderChance` blind shots, and `noise` jitter proportional to the score spread
— measured over **survivable candidates only**, because letting a `-1e6` lethal
option into the spread turns a weak bot into a uniform random picker.

`src/net/bot-session.ts` — owns its own `Game` on the same seed (so both boards
get the same pieces), thinks for `thinkMin..thinkMax` seconds, then rotates,
aims and launches. It emits `state` at 5 Hz, `gameOver` once, and its own
`curse` after holding a catch for `curseDelay`. It reports `role: 'host'` so the
*human's* controller mints the rematch seed, and it echoes `rematchRequest` so
the handshake closes. Outbound messages are queued and flushed from `update()`
rather than delivered re-entrantly from `send()`.

**`update()` is also the outbound message pump**, so main.ts drives it whenever
a bot match exists — deliberately *outside* the "match is active" gate, because
the rematch handshake happens while the versus-end screen is up. Gating it on
active deadlocks Rematch silently; `scripts/smoke-bot.mjs` guards that.

A bot match honours the player's difficulty tier (a peer match pins `normal` so
two strangers share tuning; with both boards local there is nothing to reconcile).

## Offline and updates (service worker)

GitHub Pages offers no control over cache headers, so a refresh could serve a
stale bundle indefinitely. A service worker fixes that *and* buys offline play.

`src/pwa/service-worker.js` ships as plain JS with two placeholders;
`scripts/build-sw.mjs` runs after `vite build` and replaces them with the hashed
filenames Vite emitted and a `BUILD_ID` hashed from the built bytes. Because the
id changes only when the output changes, `sw.js` is byte-identical across
rebuilds of identical source and the browser correctly reports "no update".

Strategies: navigations are served the **precached shell** (instant, offline);
`/assets/*` is **cache-first** because the filenames are content-hashed and
therefore immutable; anything else same-origin is **stale-while-revalidate**.
Cross-origin requests are **not intercepted at all** — intercepting the PeerJS
signalling traffic would break versus and gain nothing. Old `tribble-*` caches
are deleted on activate.

The worker never calls `skipWaiting()` on its own: swapping the bundle under a
running game would be hostile. A new version installs and parks in `waiting`;
`src/pwa/updates.ts` notices (`updatefound` → `statechange`, and on startup an
existing `reg.waiting` while a controller exists) and raises a corner banner.
Accepting posts `SKIP_WAITING`, and the `controllerchange` handler reloads —
**after main.ts has written `lastCoherentSave`**, so the new version comes back
with Resume available. A left-open tab re-checks on `visibilitychange` and every
15 minutes.

Connectivity is decided by a **HEAD probe of `sw.js`**, not by
`navigator.onLine`: that flag only reports whether an interface exists and stays
true behind a captive portal or a dead uplink. HEAD is not a GET, so the worker
passes it through to the network instead of answering from cache.

`scripts/gen-pwa-assets.mjs` draws the app icons in code and encodes them as PNG
using only Node's `zlib` — a web app manifest needs real raster icons, and this
keeps "no asset files" honest without adding a dependency or an undiffable blob.

## Module contracts

Every module imports shared types from `../types` (path from its folder). **Do not redeclare
shared types locally; do not import from sibling modules except where listed.** Exports below
are mandatory and must match `src/types.ts` signatures exactly.

- `src/core/rng.ts` — `createRng(seed: number): Rng` (mulberry32; `next()`, `int(n)`,
  `pick<T>(arr)`, `getState()/setState()`).
- `src/core/piece.ts` — `makeBag(rng: Rng): PieceKind[]` (7-bag), `makePiece(kind: PieceKind,
  rng: Rng): Piece` (colors = [A, A, B, B], A ≠ B), `pieceCells(piece: Piece, x: number,
  y: number): PlacedCell[]` (grid cells for a pivot at continuous (x, y): cell i's center is
  at (x + off.x, y + off.y), so col = floor(x + off.x), row = floor(y + off.y)),
  `rotatePiece(piece: Piece, dir: 1 | -1): Piece`. Shape data (`SHAPES`, `PIECE_KINDS`,
  `pieceOffsets`) already lives in `src/types.ts` — use it, do not redefine it.
- `src/core/board.ts` — `emptyGrid(): Grid`, `collides(grid: Grid, cells: PlacedCell[]):
  boolean` (occupied cell, floor, or side walls; the launcher zone rows are NOT a collision),
  `findLines(grid: Grid): number[]`, `findMatches(grid: Grid): Match[]`,
  `applyGravity(grid: Grid): boolean` (true if anything moved), `insertGarbageRow(grid: Grid,
  rng: Rng): void`, `scrambleColors(grid: Grid, rng: Rng, count: number): void`,
  `stackTopRow(grid: Grid): number` (ROWS if empty), `cloneGrid`, `gridToFlat`, `flatToGrid`.
- `src/core/game.ts` — `createGame(opts: GameOptions): Game`,
  `loadGame(save: SaveGame, opts?: Partial<GameOptions>): Game`,
  `computeAimPath(state: GameState, maxPoints?: number): AimPoint[]`.
  Owns the full simulation described above; pure logic, **no DOM/canvas/audio access**, all
  outside effects via the typed `EventBus`. Must be fully deterministic given seed + calls.
  Ship thorough vitest tests (`*.test.ts` beside sources) for: bag determinism, snap/settle
  never overlapping or out of bounds, line + match detection, gravity chains, rise & kill,
  scoring, curse effects, serialize/loadGame round-trip.
- `src/fx/juice.ts` — `createJuice(): Juice`. `src/fx/particles.ts` —
  `createParticles(): ParticleSystem` (screen-space pixels; `render(ctx)` draws with no
  transform assumptions beyond the identity).
- `src/audio/audio.ts` — `createAudio(): AudioEngine`. WebAudio only; lazy
  `AudioContext` created/resumed on `resume()` (first user gesture). No external files.
- `src/render/theme.ts` — `COLOR_HEX: Record<CellColor, string>`, `POWER_COLOR`, `UI_FONT`,
  `BG_COLOR`, `drawBlock(ctx, px, py, size, color: CellColor, alpha?: number): void`
  (rounded, beveled block used by board, previews, opponent view),
  `drawPieceThumb(ctx: CanvasRenderingContext2D, piece: Piece, sizePx: number): void`
  (centered next-piece preview; clears its rect first).
- `src/render/renderer.ts` — `createRenderer(deps: RendererDeps): Renderer`. Renders
  background, board frame, grid cells, aim path (dotted, honest), launcher + current piece,
  flying piece (+ trail hook via particles is done by main; renderer just draws state),
  power bubbles, danger vignette, opponent mini-board (right side) when `opts.opponent`,
  juice transform (offset/rotation from `deps.juice`), flash overlay, then
  `deps.particles.render(ctx)` last. DPR-aware `resize()`.
- `src/input/input.ts` — `createInput(target: HTMLElement, bindings: KeyBindings):
  InputManager`. Keyboard (by `code`), pointer events on the canvas (move/click/aux),
  discrete action callbacks + `isDown` polling + one-shot rebind capture. Ignores keys while
  rebinding or when an input/select has focus.
- `src/save/persistence.ts` — `loadSave/storeSave/clearSave`, `loadSettings/storeSettings`
  (merge with `DEFAULT_SETTINGS`), `loadBest/storeBest` (best score),
  `installAutoSave(get: () => SaveGame | null): () => void`. All localStorage access is
  wrapped in try/catch (private mode).
- `src/ui/menu.ts` — `createMenu(root: HTMLElement, settings: Settings, cb: MenuCallbacks):
  MenuApi`. Builds all screens as DOM, Material dark, ripple helper applied to buttons,
  fully keyboard navigable, focus moved on screen change, `prefers-reduced-motion` respected
  for menu animations.
- `src/ui/hud.ts` — `createHud(root: HTMLElement, drawThumb: (ctx: CanvasRenderingContext2D,
  piece: Piece, sizePx: number) => void): HudApi`. The thumb callback (injected by main.ts
  from render/theme) draws the next-piece preview, so hud imports nothing but `../types`.
- `src/net/p2p.ts` — `hostSession(name: string, onCode: (code: string) => void):
  CancellablePromise<NetSession>`, `joinSession(code: string, name: string):
  CancellablePromise<NetSession>` using the `peerjs` npm package (default public broker).
  A `CancellablePromise<T>` is `Promise<T> & { cancel(): void }`.
- `src/net/invite.ts` — room-code format (`randomCode`, `normalizeCode`, `isRoomCode`) and
  the invite links that carry it (`buildInviteUrl`, `parseInviteCode`, `extractRoomCode`,
  `hrefWithoutInvite`, plus `currentInviteCode` / `currentInviteUrl` / `clearInviteFromUrl`
  wrappers that read `location`). Pure functions take the href explicitly so they are
  testable without a DOM; no peerjs import, so the UI can use it freely.
- `src/net/versus.ts` — `createVersus(game: Game, session: NetSession, hooks: VersusHooks):
  VersusController`. Wires game events → net (state throttle 5 Hz, gameOver), net → game
  (curses via `applyCurse`, opponent snapshots → hooks), rematch handshake (host re-seeds).
- `src/main.ts` — application shell (game loop, wiring, state machine). Written by the
  integrator; do not create it.

Coding standards: TypeScript strict (tsc 7 / `moduleResolution: bundler`); no `any` unless
unavoidable; no additional npm dependencies; no `console.log` left in (console.warn/error for
real failures ok); every file self-contained with named exports only (no default exports).
Keep per-frame allocations minimal (reuse arrays/objects in hot paths).
