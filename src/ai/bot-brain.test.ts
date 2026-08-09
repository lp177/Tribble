import { describe, expect, it } from 'vitest'
import { chooseMove } from './bot-brain'
import {
  applyGravity,
  cloneGrid,
  emptyArmor,
  emptyGrid,
  findLines,
  findMatches,
  stackTopRow,
} from '../core/board'
import { computeAimPath } from '../core/game'
import { pieceCells } from '../core/piece'
import { createRng } from '../core/rng'
import {
  BIG_PIECE_KINDS,
  BOT_LEVELS,
  COLS,
  MAX_AIM_ANGLE,
  PIECE_KINDS,
  ROWS,
  type BotMove,
  type CellColor,
  type GameState,
  type Grid,
  type Piece,
  type PieceKind,
  type PowerBubble,
  type Rotation,
} from '../types'

// ---------------------------------------------------------------------------
// Fixtures
//
// Every fixture is a board the engine could actually have left behind: no full
// lines and no colour groups of 3+ waiting to pop. `x` paints a cell with a
// colour that differs from both orthogonal neighbours, which is the cheap way to
// keep a filled region match-free; digits pin a colour deliberately.
// ---------------------------------------------------------------------------

function tint(row: number, col: number): CellColor {
  return ((row * 2 + col) % 4) as CellColor
}

/** Builds a grid from `.`/`x`/digit rows anchored to the BOTTOM of the board. */
function gridFrom(rows: string[]): Grid {
  const grid = emptyGrid()
  const offset = ROWS - rows.length
  for (let i = 0; i < rows.length; i++) {
    const r = offset + i
    for (let c = 0; c < COLS; c++) {
      const ch = rows[i][c]
      if (ch === undefined || ch === '.') continue
      grid[r][c] = ch === 'x' ? tint(r, c) : (Number(ch) as CellColor)
    }
  }
  return grid
}

function piece(kind: PieceKind, colors: CellColor[], rot: Rotation = 0): Piece {
  return { kind, rot, colors }
}

function makeState(over: Partial<GameState> = {}): GameState {
  const base: GameState = {
    grid: emptyGrid(),
    armor: emptyArmor(),
    difficulty: 'normal',
    hazards: [],
    colorsLocked: false,
    hazardTimer: Infinity,
    phase: 'aiming',
    current: piece('I', [0, 0, 1, 1]),
    next: piece('O', [2, 2, 3, 3]),
    flying: null,
    aimAngle: 0,
    score: 0,
    level: 1,
    clearsTotal: 0,
    chain: 0,
    combo: 0,
    elapsed: 0,
    riseTimer: 10,
    riseInterval: 10,
    danger: false,
    versus: true,
    powers: [],
    inventory: [],
    activeCurses: [],
  }
  return { ...base, ...over }
}

/**
 * Columns of random height with occasional holes, coloured so that no two
 * orthogonal neighbours share a colour — i.e. a settled board, the only kind the
 * bot is ever asked to play from.
 */
function randomBoard(seed: number, maxHeight: number): Grid {
  const rng = createRng(seed)
  const grid = emptyGrid()
  for (let c = 0; c < COLS; c++) {
    const h = rng.int(maxHeight + 1)
    for (let i = 0; i < h; i++) {
      const r = ROWS - 1 - i
      if (rng.next() < 0.12) continue
      const below = r + 1 < ROWS ? grid[r + 1][c] : null
      const left = c > 0 ? grid[r][c - 1] : null
      let color = rng.int(4) as CellColor
      for (let t = 0; t < 4 && (color === below || color === left); t++) {
        color = ((color + 1) % 4) as CellColor
      }
      grid[r][c] = color
    }
  }
  return grid
}

// ---------------------------------------------------------------------------
// Independent oracle: land a move and resolve it the way the engine would.
// It shares no code with the search — only the engine's own kinematics and the
// board primitives, which core/*.test.ts already pins down — so it can judge the
// bot's choice AND prove a fixture really offers the option a test claims.
// ---------------------------------------------------------------------------

interface Outcome {
  lines: number
  cells: number
  matches: number
  maxHeight: number
}

function land(state: GameState, angle: number, rot: Rotation): Outcome {
  const shot = piece(state.current.kind, state.current.colors as CellColor[], rot)
  const path = computeAimPath({ ...state, current: shot, aimAngle: angle })
  const rest = path[path.length - 1]
  const grid = cloneGrid(state.grid)
  for (const cell of pieceCells(shot, rest.x, rest.y)) {
    if (cell.row < 0 || cell.row >= ROWS || cell.col < 0 || cell.col >= COLS) continue
    grid[cell.row][cell.col] = cell.color
  }

  let lines = 0
  let cells = 0
  let matches = 0
  for (let guard = 0; guard < 32; guard++) {
    const rows = findLines(grid)
    const groups = state.colorsLocked ? [] : findMatches(grid)
    if (rows.length === 0 && groups.length === 0) break
    const doomed = new Set<number>()
    for (const r of rows) {
      for (let c = 0; c < COLS; c++) doomed.add(r * COLS + c)
    }
    for (const g of groups) {
      for (const cell of g.cells) doomed.add(cell.row * COLS + cell.col)
    }
    for (const idx of doomed) grid[Math.floor(idx / COLS)][idx % COLS] = null
    lines += rows.length
    matches += groups.length
    cells += doomed.size
    applyGravity(grid)
  }
  return { lines, cells, matches, maxHeight: ROWS - stackTopRow(grid) }
}

function outcomeOf(state: GameState, move: BotMove): Outcome {
  return land(state, move.angle, move.rot)
}

/** Every (angle, rotation) the search could consider, with its real outcome. */
function enumerate(state: GameState, steps: number): Outcome[] {
  const out: Outcome[] = []
  for (let i = 0; i < steps; i++) {
    const angle = -MAX_AIM_ANGLE + (2 * MAX_AIM_ANGLE * i) / (steps - 1)
    for (let rot = 0; rot < 4; rot++) out.push(land(state, angle, rot as Rotation))
  }
  return out
}

/** Closest approach of a move's flight to a bubble, in cell units. */
function passDistance(state: GameState, move: BotMove, bubble: PowerBubble): number {
  const shot = piece(state.current.kind, state.current.colors as CellColor[], move.rot)
  const path = computeAimPath({ ...state, current: shot, aimAngle: move.angle })
  let best = Infinity
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((bubble.x - a.x) * dx + (bubble.y - a.y) * dy) / len2 : 0
    t = Math.min(1, Math.max(0, t))
    const d = Math.hypot(bubble.x - (a.x + dx * t), bubble.y - (a.y + dy * t))
    if (d < best) best = d
  }
  return best
}

// ---------------------------------------------------------------------------

describe('chooseMove', () => {
  it('is deterministic for the same state and seed', () => {
    const state = makeState({ grid: randomBoard(7, 9), current: piece('T', [1, 1, 2, 2]) })
    const a = chooseMove(state, BOT_LEVELS.rookie, createRng(1234))
    // A different search in between must not leak through the shared buffers.
    chooseMove(state, BOT_LEVELS.merciless, createRng(99))
    const b = chooseMove(state, BOT_LEVELS.rookie, createRng(1234))
    expect(b).toEqual(a)
  })

  it('actually consumes the injected Rng, so seeds diverge', () => {
    const state = makeState({ grid: randomBoard(11, 9), current: piece('S', [0, 0, 3, 3]) })
    const first = chooseMove(state, BOT_LEVELS.rookie, createRng(1))
    let diverged = false
    for (let seed = 2; seed < 40 && !diverged; seed++) {
      const other = chooseMove(state, BOT_LEVELS.rookie, createRng(seed))
      diverged = other.angle !== first.angle || other.rot !== first.rot
    }
    expect(diverged).toBe(true)
  })

  it('returns a legal move for every piece kind, level and board', () => {
    const kinds: PieceKind[] = [...PIECE_KINDS, ...BIG_PIECE_KINDS]
    expect(kinds).toHaveLength(12)

    for (const levelId of ['rookie', 'skilled', 'merciless'] as const) {
      const level = BOT_LEVELS[levelId]
      for (let b = 0; b < 6; b++) {
        const grid = randomBoard(1000 + b, b === 5 ? 16 : 10)
        for (let k = 0; k < kinds.length; k++) {
          const state = makeState({
            grid,
            current: piece(kinds[k], [2, 2, 0, 0], (k % 4) as Rotation),
          })
          const move = chooseMove(state, level, createRng(b * 97 + k))
          expect(Number.isFinite(move.angle)).toBe(true)
          expect(Math.abs(move.angle)).toBeLessThanOrEqual(MAX_AIM_ANGLE + 1e-12)
          expect(Number.isInteger(move.rot)).toBe(true)
          expect(move.rot).toBeGreaterThanOrEqual(0)
          expect(move.rot).toBeLessThanOrEqual(3)
          expect(Number.isFinite(move.score)).toBe(true)
        }
      }
    }
  })

  it('survives an empty board and a jammed one', () => {
    const emptyMove = chooseMove(makeState(), BOT_LEVELS.merciless, createRng(3))
    expect(Number.isFinite(emptyMove.angle)).toBe(true)
    expect(Number.isFinite(emptyMove.score)).toBe(true)

    const full = emptyGrid()
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) full[r][c] = tint(r, c)
    }
    const jammed = makeState({ grid: full, current: piece('Y', [1, 1, 3, 3]) })
    const jammedMove = chooseMove(jammed, BOT_LEVELS.merciless, createRng(4))
    expect(Number.isFinite(jammedMove.angle)).toBe(true)
    expect(Math.abs(jammedMove.angle)).toBeLessThanOrEqual(MAX_AIM_ANGLE + 1e-12)
    expect(Number.isFinite(jammedMove.score)).toBe(true)
  })

  it('merciless takes an obvious one-shot line clear', () => {
    const state = makeState({
      grid: gridFrom(['xxxxx.xxxxx']),
      current: piece('I', [0, 0, 1, 1]),
    })
    // The fixture must really offer the clear, or this proves nothing.
    expect(enumerate(state, 25).some((o) => o.lines > 0)).toBe(true)

    const move = chooseMove(state, BOT_LEVELS.merciless, createRng(5))
    expect(outcomeOf(state, move).lines).toBeGreaterThan(0)
  })

  it('merciless will not raise the stack when a flatter option exists', () => {
    // A tower right under the launcher: firing straight down is the lazy move.
    const grid = gridFrom([
      '.....x.....',
      '.....x.....',
      '.....x.....',
      '.....x.....',
      '.....x.....',
      '.....x.....',
      '.....x.....',
      '.....x.....',
      'xxxxxxxxxx.',
      'xxxxxxxxxx.',
    ])
    const state = makeState({ grid, current: piece('L', [0, 0, 3, 3]) })
    const before = ROWS - stackTopRow(grid)
    expect(before).toBe(10)

    const options = enumerate(state, 25)
    expect(options.some((o) => o.maxHeight > before)).toBe(true) // the trap exists
    expect(options.some((o) => o.maxHeight <= before)).toBe(true) // so does a way out

    const move = chooseMove(state, BOT_LEVELS.merciless, createRng(6))
    expect(outcomeOf(state, move).maxHeight).toBeLessThanOrEqual(before)
  })

  it('prefers the line over a colour match when colours are locked', () => {
    // Two stacked 1s at column 2 are one block short of a match; the floor is one
    // block short of a line. Both are reachable, so the tiers really do choose.
    const rows = ['..1........', '..1........', 'xxxxx.xxxxx']
    const current = piece('T', [1, 1, 2, 2])

    const colourful = makeState({ grid: gridFrom(rows), current })
    const options = enumerate(colourful, 25)
    expect(options.some((o) => o.lines > 0)).toBe(true)
    expect(options.some((o) => o.lines === 0 && o.matches > 0)).toBe(true)

    const locked = makeState({ grid: gridFrom(rows), current, colorsLocked: true })
    const move = chooseMove(locked, BOT_LEVELS.merciless, createRng(7))
    const outcome = outcomeOf(locked, move)
    expect(outcome.lines).toBeGreaterThan(0)
    // With colours dead, nothing but lines may count as progress.
    expect(outcome.matches).toBe(0)
  })

  it('scales its noise to the survivable moves, not to the death penalty', () => {
    // Nine columns one row short of the kill zone; the two-wide well on the right
    // is the only safe place to put anything. A fatal candidate carries a penalty
    // five orders of magnitude bigger than any real score difference, so folding
    // it into the noise spread would leave a weak bot picking safe moves purely
    // at random instead of merely playing badly.
    const rows: string[] = []
    for (let i = 0; i < 16; i++) rows.push('xxxxxxxxx..')
    const state = makeState({ grid: gridFrom(rows), current: piece('O', [0, 0, 2, 2]) })

    const options = enumerate(state, BOT_LEVELS.rookie.angleSteps)
    expect(options.some((o) => o.maxHeight > ROWS - 3)).toBe(true) // fatal moves exist
    expect(options.some((o) => o.maxHeight <= ROWS - 3)).toBe(true) // so do safe ones

    // Blunders are meant to be reckless; this is about the search itself.
    const noisy = { ...BOT_LEVELS.rookie, blunderChance: 0 }
    let total = 0
    for (let seed = 1; seed <= 40; seed++) {
      const move = chooseMove(state, noisy, createRng(seed))
      expect(outcomeOf(state, move).maxHeight).toBeLessThanOrEqual(ROWS - 3)
      total += move.score
    }
    // Noise may cost the weak bot some board quality, but nowhere near the value
    // of a line clear (~60) — it is still choosing, not rolling dice.
    const best = chooseMove(state, BOT_LEVELS.merciless, createRng(1)).score
    expect(total / 40).toBeGreaterThan(best - 50)
  })

  it('merciless outplays rookie across a sample of boards', () => {
    let merciless = 0
    let rookie = 0
    const boards = 24
    for (let b = 0; b < boards; b++) {
      // No power bubbles: the levels differ in powerAppetite, and the scores are
      // only comparable while both are scoring the same function.
      const state = makeState({
        grid: randomBoard(500 + b, 11),
        current: piece(PIECE_KINDS[b % PIECE_KINDS.length], [1, 1, 3, 3]),
      })
      merciless += chooseMove(state, BOT_LEVELS.merciless, createRng(b + 1)).score
      rookie += chooseMove(state, BOT_LEVELS.rookie, createRng(b + 1)).score
    }
    expect(merciless / boards).toBeGreaterThan(rookie / boards)
  })

  it('steers the shot through a power bubble', () => {
    const bubble: PowerBubble = { id: 1, kind: 'garbage', x: 9.2, y: 12, age: 0 }
    const hungry = makeState({ current: piece('O', [0, 0, 2, 2]), powers: [bubble] })
    const blind = makeState({ current: piece('O', [0, 0, 2, 2]) })

    const greedyMove = chooseMove(hungry, BOT_LEVELS.merciless, createRng(8))
    const blindMove = chooseMove(blind, BOT_LEVELS.merciless, createRng(8))
    expect(passDistance(hungry, greedyMove, bubble)).toBeLessThan(
      passDistance(blind, blindMove, bubble),
    )
  })

  it('ignores power bubbles it could not store', () => {
    const bubble: PowerBubble = { id: 1, kind: 'garbage', x: 9.2, y: 12, age: 0 }
    const hungry = makeState({ current: piece('O', [0, 0, 2, 2]), powers: [bubble] })
    const stuffed = makeState({
      current: piece('O', [0, 0, 2, 2]),
      powers: [bubble],
      inventory: ['fog', 'speed', 'mirror'],
    })
    const blind = makeState({ current: piece('O', [0, 0, 2, 2]) })

    const greedyMove = chooseMove(hungry, BOT_LEVELS.merciless, createRng(9))
    const stuffedMove = chooseMove(stuffed, BOT_LEVELS.merciless, createRng(9))
    const blindMove = chooseMove(blind, BOT_LEVELS.merciless, createRng(9))
    expect(stuffedMove).toEqual(blindMove)
    expect(stuffedMove).not.toEqual(greedyMove)
  })

  it('runs a merciless search in a few milliseconds', () => {
    const state = makeState({
      grid: randomBoard(4242, 12),
      current: piece('F', [2, 2, 1, 1]),
      powers: [
        { id: 1, kind: 'fog', x: 3.2, y: 9, age: 0 },
        { id: 2, kind: 'speed', x: 8.4, y: 5, age: 0 },
      ],
    })
    // Warm the JIT so this measures the search, not first-run compilation.
    for (let i = 0; i < 5; i++) chooseMove(state, BOT_LEVELS.merciless, createRng(i))

    const t0 = performance.now()
    chooseMove(state, BOT_LEVELS.merciless, createRng(1))
    expect(performance.now() - t0).toBeLessThan(60)
  })
})
