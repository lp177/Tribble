# Tribble 🔮

**Tribble** is a browser game that mixes **Tetris** with a **bubble shooter**: a launcher at the
top of the screen fires tetromino pieces *downward* onto a stack that slowly rises from the
bottom. Aim with the guide line, rotate your piece, bounce it off the walls, and clear cells
before the stack reaches your launcher.

**▶ Play it: <https://lp177.github.io/Tribble/>**

## How it works

- **Aim & launch** — the dotted line shows exactly where your piece will land, wall bounces
  included. You can still rotate the piece mid-flight.
- **Two ways to clear** — complete a full horizontal **line** (Tetris style), or connect
  **3+ blocks of the same color** (bubble-shooter style). Cleared cells make everything above
  fall, which can trigger **chain reactions** with big multipliers.
- **The stack rises** — a new garbage row pushes up from the bottom on a timer, and the pace
  quickens with both the clock *and* your level, so playing well tightens the screws.
- **Four difficulty tiers**, picked right on the title screen: **Chill** (no hazards, gentle
  rise), **Normal**, **Hard** (fast rise, frequent hazards, armoured blocks) and **Hardcore** —
  stone only, so colour matching is dead and lines are all you get, with no aim guide drawn.
  Harder tiers score up to 2.5×.
- **Random hazards** interrupt a solo run and change how you play for a few seconds:
  **Stonefall** (colours go dead — clear lines), **Reinforced** (blocks need two breaks),
  **Giants** (oversized pentominoes) and **Rush** (the stack climbs at double speed).
- **Game feel** — screen shake, hit-stop, particles and procedural sound effects, all
  synthesized in the browser with no asset files. Honors `prefers-reduced-motion` (and a
  Settings override).
- **Music that follows the match** — six generative tracks in different modes and tempos, one
  picked at random each run so no two games sound alike. The score tightens with your speed,
  and dramatic swings take it over: the stack reaching the danger zone, a curse landing, a
  caught power bubble. When the moment passes, it cross-fades to a fresh track.
- **Auto-save** — close the tab mid-game and the title screen offers **Resume** next time.
- **Installable and offline** — a service worker precaches the whole game, so it starts
  instantly and plays with no connection at all (only versus needs the network). It keeps
  checking for new deploys in the background and offers a **Reload** prompt when one lands,
  saving your run first — so a refresh can never leave you stuck on a stale build.
- **Versus mode** — peer-to-peer over WebRTC (PeerJS): host a room, share the 5-letter code.
  Clearing cells can release **power bubbles** that float toward the top — catch one with a
  launched piece to store a **curse** (garbage rows, speed-up, fog, scramble, mirrored
  controls, rotation lock) and unleash it on your opponent. Last board standing wins.

## Controls (rebindable in Settings)

| Action | Default |
| --- | --- |
| Aim | Mouse move, or `←` / `→` (`A` / `D`) |
| Launch | Click or `Space` |
| Rotate | Right-click, `↑` / `X` (CW), `Z` (CCW) |
| Send curse (versus) | `C` |
| Pause | `Escape` |

A versus match cannot be paused — your opponent keeps playing — so `Escape` there arms a
forfeit instead, and asks for a second press to confirm.

## Development

```sh
npm install
npm run dev        # local dev server
npm test           # core simulation unit tests (vitest)
npm run build      # typecheck + production build into docs/ (GitHub Pages)
```

Stack: TypeScript + Vite, one `<canvas>`, DOM menus, WebAudio synthesis, PeerJS for
networking. No frameworks, no asset files. The production build is committed under `docs/`
and served by GitHub Pages.

Architecture and game-rule details live in [DESIGN.md](DESIGN.md); `src/types.ts` holds the
shared contracts between the simulation (`src/core/`), presentation (`src/render/`, `src/fx/`,
`src/audio/`, `src/ui/`), and I/O (`src/input/`, `src/save/`, `src/net/`).

## Credits

Inspired by the greats: Tetris Effect: Connected, TETR.IO, Puyo Puyo Tetris and Tricky Towers.
Built with [Claude Code](https://claude.com/claude-code).
