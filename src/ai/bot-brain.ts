// Tribble — the AI opponent's move search.
//
// Pure by design: no DOM, no timers, no clock, and no randomness except through
// the injected Rng. That is what makes a bot match reproducible from a seed, and
// what lets the tests assert real competence instead of "it returned something".
//
// The search never simulates a Game. `computeAimPath` already runs the engine's
// own kinematics — its last point is exactly the pivot where the piece comes to
// rest after the snap and settle — so a candidate can be evaluated by writing
// that placement into a scratch grid and resolving it the way `resolveStep`
// would. Exact, and an order of magnitude cheaper than cloning the engine.

import {
  COLS,
  MAX_AIM_ANGLE,
  MAX_INVENTORY,
  POWER_RADIUS,
  ROWS,
  TOP_KILL_ROW,
  pieceOffsets,
  type AimPoint,
  type BotLevelConfig,
  type BotMove,
  type Cell,
  type GameState,
  type Grid,
  type Piece,
  type PieceKind,
  type Rng,
} from '../types'
import { applyGravity, findLines, findMatches } from '../core/board'
import { computeAimPath } from '../core/game'
import { rotatePiece } from '../core/piece'

// ---------------------------------------------------------------------------
// Scoring weights
//
// A board-quality heuristic in the Dellacherie / "El-Tetris" family, retuned for
// this game. Two things differ from plain Tetris: clears are worth more (they
// also feed the versus curse economy through power bubbles), and topping out is
// the *only* way to lose, so eating the headroom above the stack is punished far
// harder than mere untidiness.
//
// The unit is arbitrary; only the ratios matter. Reference points used to tune:
//   * one line clear on an 11-wide board is worth ~11 * CELL + LINE ≈ 61, which
//     must comfortably beat any amount of cosmetic flattening (a whole row of
//     bumpiness is ~9);
//   * one new hole (-7.5) costs slightly more than raising the entire board by a
//     row (~6.2) — the same trade a human makes: only bury a cell for a clear;
//   * DANGER is quadratic in the *remaining headroom*, not in the height, so it
//     is nearly flat on a low board and brutal near the top: 36 at four rows of
//     headroom (already more than a 3-cell colour match), 196 at zero (more than
//     a line clear). That is the escalation that keeps the bot alive.
// ---------------------------------------------------------------------------

/** Per cell removed by any clear. */
const W_CELL = 3.2
/** Per full line, applied as n^1.5 within a resolve step (simultaneous lines). */
const W_LINE = 26
/** Per extra cascade step beyond the first; chains are worth chasing. */
const W_CASCADE = 18
const W_HOLE = 7.5
const W_AGG_HEIGHT = 0.45
const W_BUMPINESS = 0.9
const W_MAX_HEIGHT = 1.2
/** Headroom (rows between the stack and the kill zone) below which panic starts. */
const SAFE_HEADROOM = 7
const W_DANGER = 4
/** Topping out is not a bad move, it is the end of the match. */
const DEATH_PENALTY = 1e6

/** Value of flying through a power bubble, before `level.powerAppetite`. */
const W_POWER = 30
/**
 * How far outside POWER_RADIUS the bonus still pulls. The path we measure is the
 * *pivot* trajectory while the engine catches with the piece's cells, so a bubble
 * up to about a cell off the pivot line is still a realistic catch; the linear
 * falloff turns that into a gradient the search can climb.
 */
const POWER_NEAR = 1.4

/** Cascades terminate on their own; this only bounds a pathological board. */
const MAX_RESOLVE_STEPS = 24

/**
 * Rotations that place genuinely different cells. Beyond these the shape repeats
 * (translated) and only the orientation of the colour pairing changes — a
 * marginal effect next to doubling or quadrupling the search cost.
 */
const DISTINCT_ROTATIONS: Record<PieceKind, number> = {
  I: 2,
  O: 1,
  T: 4,
  S: 2,
  Z: 2,
  J: 4,
  L: 4,
  P: 4,
  U: 4,
  W: 4,
  F: 4,
  Y: 4,
}

// -- Reused buffers ---------------------------------------------------------
// The search runs inside the game loop, so nothing here allocates per candidate.
// Single-threaded and never held across a call, exactly like board.ts's buffers.

const work: Grid = (() => {
  const g: Grid = []
  for (let r = 0; r < ROWS; r++) g.push(new Array<Cell>(COLS).fill(null))
  return g
})()
const mask = new Uint8Array(ROWS * COLS)
const heights = new Int32Array(COLS)
const candAngle: number[] = []
const candRot: number[] = []
const candScore: number[] = []

function clampAngle(a: number): number {
  if (!Number.isFinite(a)) return 0
  return a < -MAX_AIM_ANGLE ? -MAX_AIM_ANGLE : a > MAX_AIM_ANGLE ? MAX_AIM_ANGLE : a
}

/** Distance from (px, py) to the segment a->b, in cell units. */
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

/** Bonus for a flight that would sweep a power bubble into the inventory. */
function powerScore(state: GameState, path: AimPoint[], appetite: number): number {
  // A full inventory drops the catch on the floor, so steering for one is a lie.
  if (appetite <= 0 || state.powers.length === 0) return 0
  if (state.inventory.length >= MAX_INVENTORY) return 0

  let total = 0
  for (let i = 0; i < state.powers.length; i++) {
    const p = state.powers[i]
    let best = Infinity
    for (let s = 1; s < path.length; s++) {
      const d = segmentDistance(p.x, p.y, path[s - 1].x, path[s - 1].y, path[s].x, path[s].y)
      if (d < best) best = d
    }
    if (best <= POWER_RADIUS) total += W_POWER
    else if (best < POWER_RADIUS + POWER_NEAR) {
      total += W_POWER * (1 - (best - POWER_RADIUS) / POWER_NEAR)
    }
  }
  return total * appetite
}

/**
 * Score the board that would result from launching `piece` at `angle`.
 * Returns NaN when the candidate is not playable at all, so the caller skips it.
 *
 * `probe` is a shallow view of the real state: `computeAimPath` reads nothing but
 * `grid`, `current` and `aimAngle`, so mutating those two fields is enough — and
 * avoids a fresh object per candidate.
 */
function evaluate(
  state: GameState,
  probe: GameState,
  piece: Piece,
  angle: number,
  level: BotLevelConfig,
): number {
  probe.current = piece
  probe.aimAngle = angle
  const path = computeAimPath(probe)
  const rest = path[path.length - 1]
  if (rest === undefined || !Number.isFinite(rest.x) || !Number.isFinite(rest.y)) return NaN

  const grid = state.grid
  for (let r = 0; r < ROWS; r++) {
    const dst = work[r]
    const src = grid[r]
    for (let c = 0; c < COLS; c++) dst[c] = src[c]
  }

  // Land the piece. Cells above the board are the engine's instant game over.
  let dead = false
  const offs = pieceOffsets(piece)
  for (let i = 0; i < offs.length; i++) {
    const row = Math.floor(rest.y + offs[i].y)
    const col = Math.floor(rest.x + offs[i].x)
    if (col < 0 || col >= COLS || row >= ROWS) return NaN
    if (row < 0) {
      dead = true
      continue
    }
    work[row][col] = piece.colors[i]
  }

  // Resolve exactly as the engine does: lines and (unless colours are locked)
  // colour groups clear together, gravity falls, repeat until nothing goes.
  // Armour is deliberately ignored — it delays a clear by one hit at most.
  let clearedCells = 0
  let lineScore = 0
  let cascades = 0
  for (let step = 0; step < MAX_RESOLVE_STEPS; step++) {
    const lines = findLines(work)
    const matches = state.colorsLocked ? null : findMatches(work)
    if (lines.length === 0 && (matches === null || matches.length === 0)) break

    mask.fill(0)
    for (let i = 0; i < lines.length; i++) {
      const base = lines[i] * COLS
      for (let c = 0; c < COLS; c++) mask[base + c] = 1
    }
    if (matches !== null) {
      for (let i = 0; i < matches.length; i++) {
        const cells = matches[i].cells
        for (let j = 0; j < cells.length; j++) mask[cells[j].row * COLS + cells[j].col] = 1
      }
    }

    let removed = 0
    for (let r = 0; r < ROWS; r++) {
      const row = work[r]
      const base = r * COLS
      for (let c = 0; c < COLS; c++) {
        if (mask[base + c] !== 1) continue
        row[c] = null
        removed++
      }
    }
    if (removed === 0) break

    clearedCells += removed
    lineScore += Math.pow(lines.length, 1.5)
    cascades++
    applyGravity(work)
  }

  // Board quality of what is left.
  let agg = 0
  let holes = 0
  let maxHeight = 0
  for (let c = 0; c < COLS; c++) {
    let height = 0
    let colHoles = 0
    for (let r = 0; r < ROWS; r++) {
      if (work[r][c] !== null) {
        if (height === 0) height = ROWS - r
      } else if (height !== 0) colHoles++
    }
    heights[c] = height
    agg += height
    holes += colHoles
    if (height > maxHeight) maxHeight = height
  }
  let bumpiness = 0
  for (let c = 1; c < COLS; c++) bumpiness += Math.abs(heights[c] - heights[c - 1])

  let score =
    W_CELL * clearedCells +
    W_LINE * lineScore +
    W_CASCADE * Math.max(0, cascades - 1) -
    W_AGG_HEIGHT * agg -
    W_HOLE * holes -
    W_BUMPINESS * bumpiness -
    W_MAX_HEIGHT * maxHeight

  const headroom = ROWS - maxHeight - TOP_KILL_ROW
  if (headroom < SAFE_HEADROOM) {
    const over = SAFE_HEADROOM - headroom
    score -= W_DANGER * over * over
  }
  if (dead || headroom < 0) score -= DEATH_PENALTY

  return score + powerScore(state, path, level.powerAppetite)
}

/** The rotations worth trying, starting from the piece as it is now. */
function rotationVariants(piece: Piece, out: Piece[]): void {
  out.length = 0
  out.push(piece)
  const n = DISTINCT_ROTATIONS[piece.kind]
  let p = piece
  for (let i = 1; i < n; i++) {
    p = rotatePiece(p, 1)
    out.push(p)
  }
}

/**
 * Pick the launch the bot believes in: aim angle plus the absolute rotation the
 * piece should be in. Deterministic for a given state, level and Rng stream.
 */
export function chooseMove(state: GameState, level: BotLevelConfig, rng: Rng): BotMove {
  const variants: Piece[] = []
  rotationVariants(state.current, variants)
  const probe: GameState = { ...state }

  // A blunder is a real bad move, not a handicap bolted on afterwards: the bot
  // fires without looking and lives with whatever the board becomes. The shot is
  // still scored afterwards, purely so `score` means the same thing every time.
  if (level.blunderChance > 0 && rng.next() < level.blunderChance) {
    const angle = clampAngle((rng.next() * 2 - 1) * MAX_AIM_ANGLE)
    const piece = variants[rng.int(variants.length)]
    const score = evaluate(state, probe, piece, angle, level)
    return { angle, rot: piece.rot, score: Number.isFinite(score) ? score : 0 }
  }

  const steps = Math.max(1, Math.floor(level.angleSteps))
  candAngle.length = 0
  candRot.length = 0
  candScore.length = 0

  // The spread that scales the noise is measured over the survivable moves only.
  // A lethal candidate carries DEATH_PENALTY, five orders of magnitude past any
  // real score difference; folding it in would make the jitter so large that a
  // weak bot picks uniformly at random among the safe moves. That is not weak
  // play, it is no play at all — and it happens exactly on the crowded boards
  // where the difference between the tiers should show.
  let best = -Infinity
  let worst = Infinity
  for (let i = 0; i < steps; i++) {
    const angle = steps === 1 ? 0 : -MAX_AIM_ANGLE + (2 * MAX_AIM_ANGLE * i) / (steps - 1)
    for (let v = 0; v < variants.length; v++) {
      const score = evaluate(state, probe, variants[v], angle, level)
      if (!Number.isFinite(score)) continue
      candAngle.push(angle)
      candRot.push(variants[v].rot)
      candScore.push(score)
      if (score <= -DEATH_PENALTY * 0.5) continue
      if (score > best) best = score
      if (score < worst) worst = score
    }
  }

  if (candScore.length === 0) {
    // Nothing was even placeable (a jammed board). Fire straight down as-is.
    return { angle: 0, rot: state.current.rot, score: 0 }
  }

  let pick = 0
  if (level.noise > 0 && best > worst) {
    // Jitter scaled to the spread of the survivable moves, so "weak" means
    // genuinely choosing a worse move. The same weight barely matters on a flat
    // board, which is right: when every option is equivalent there is nothing to
    // get wrong.
    const spread = best - worst
    let bestNoisy = -Infinity
    for (let i = 0; i < candScore.length; i++) {
      const noisy = candScore[i] + (rng.next() * 2 - 1) * level.noise * spread
      if (noisy > bestNoisy) {
        bestNoisy = noisy
        pick = i
      }
    }
  } else {
    for (let i = 1; i < candScore.length; i++) {
      if (candScore[i] > candScore[pick]) pick = i
    }
  }

  // The reported score is the honest evaluation of the chosen move, never the
  // jittered one: tests compare levels by it.
  return {
    angle: clampAngle(candAngle[pick]),
    rot: (candRot[pick] & 3) as BotMove['rot'],
    score: candScore[pick],
  }
}
