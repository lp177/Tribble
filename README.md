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
- **The stack rises** — a new garbage row pushes up from the bottom on a timer. The pace
  increases over time, but ever more slowly, so the pressure ramps without becoming unfair.
- **Game feel** — screen shake, hit-stop, particles, procedural sound effects and generative
  music, all synthesized in the browser (no asset files). Honors `prefers-reduced-motion`.
- **Auto-save** — close the tab mid-game and the title screen offers **Resume** next time.
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
