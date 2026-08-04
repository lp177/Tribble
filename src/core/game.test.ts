import { describe, expect, it } from 'vitest'
import {
  BIG_PIECE_KINDS,
  CLEARS_PER_LEVEL,
  COLS,
  CURSE_DURATION,
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  HAZARD_ARMOR,
  HAZARD_DURATION,
  HAZARD_KINDS,
  MAX_AIM_ANGLE,
  MAX_INVENTORY,
  MAX_POWERS,
  RISE_MIN,
  RISE_START,
  RISE_TAU,
  ROWS,
  TOP_KILL_ROW,
  type CellColor,
  type CurseKind,
  type Difficulty,
  type Game,
  type Grid,
  type HazardKind,
  type Piece,
  type PlacedCell,
} from '../types'
import { cloneGrid, findLines, stackTopRow } from './board'
import { pieceCells } from './piece'
import { createRng } from './rng'
import { computeAimPath, createGame, loadGame } from './game'

const FRAME = 1 / 60
/** The rise interval never drops below this, whatever the tier and level ask. */
const RISE_FLOOR = 0.8

function clearGrid(grid: Grid): void {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) grid[r][c] = null
  }
}

function clearArmor(armor: number[][]): void {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) armor[r][c] = 0
  }
}

/** Empties the board and stops the ambient pressure, so a script stays as written. */
function quiet(game: Game): void {
  clearGrid(game.state.grid)
  clearArmor(game.state.armor)
  game.state.riseTimer = 1e6
  game.state.hazardTimer = Infinity
}

/** Installs a hazard by hand, exactly as a roll would (only one ever runs). */
function forceHazard(game: Game, kind: HazardKind, remaining = 1e6): void {
  game.state.hazards.length = 0
  game.state.hazards.push({ kind, remaining })
  if (kind === 'stone') game.state.colorsLocked = true
}

/** Runs the clock with the board held still — the hazard timer's home turf. */
function idle(game: Game, seconds: number, dt = 0.05): void {
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) {
    game.state.riseTimer = 1e6
    game.update(dt)
  }
}

/** Launches at `angle` and pumps frames until the engine is idle again. */
function runLaunch(game: Game, angle: number, maxFrames = 600): number {
  game.setAim(angle)
  game.launch()
  let frames = 0
  while (game.state.phase !== 'aiming' && game.state.phase !== 'gameover' && frames < maxFrames) {
    game.update(FRAME)
    frames++
  }
  return frames
}

function pieceSignature(p: Piece): string {
  return `${p.kind}:${p.rot}:${p.colors.join(',')}`
}

function filledCount(grid: Grid): number {
  let n = 0
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) if (grid[r][c] !== null) n++
  }
  return n
}

describe('determinism', () => {
  it('produces the same piece stream for the same seed', () => {
    const a = createGame({ seed: 1234 })
    const b = createGame({ seed: 1234 })
    expect(pieceSignature(a.state.current)).toBe(pieceSignature(b.state.current))
    expect(pieceSignature(a.state.next)).toBe(pieceSignature(b.state.next))

    const angles = [0, 0.4, -0.7, 1.1, -1.2, 0.2, 0.9, -0.3]
    const seqA: string[] = []
    const seqB: string[] = []
    for (let i = 0; i < 24; i++) {
      const angle = angles[i % angles.length]
      runLaunch(a, angle)
      runLaunch(b, angle)
      seqA.push(pieceSignature(a.state.next))
      seqB.push(pieceSignature(b.state.next))
    }
    expect(seqA).toEqual(seqB)
    expect(a.state.score).toBe(b.state.score)
    expect(a.serialize().grid).toEqual(b.serialize().grid)
  })

  it('produces different sequences for different seeds', () => {
    const a = createGame({ seed: 1 })
    const b = createGame({ seed: 999 })
    const seqA: string[] = []
    const seqB: string[] = []
    for (let i = 0; i < 12; i++) {
      runLaunch(a, 0)
      runLaunch(b, 0)
      seqA.push(pieceSignature(a.state.next))
      seqB.push(pieceSignature(b.state.next))
    }
    expect(seqA).not.toEqual(seqB)
  })

  it('keeps the piece stream independent from garbage/power randomness', () => {
    const plain = createGame({ seed: 77 })
    const cursed = createGame({ seed: 77 })
    // Only the misc stream is disturbed: pieces must stay in lockstep.
    cursed.addGarbage(3)
    cursed.applyCurse('scramble')

    const seqPlain: string[] = []
    const seqCursed: string[] = []
    for (let i = 0; i < 10; i++) {
      seqPlain.push(pieceSignature(plain.state.current))
      seqCursed.push(pieceSignature(cursed.state.current))
      runLaunch(plain, 0.3)
      runLaunch(cursed, 0.3)
    }
    expect(seqCursed).toEqual(seqPlain)
  })
})

describe('new game', () => {
  it('starts with garbage rows, aiming, and a full rise timer', () => {
    const game = createGame({ seed: 5 })
    const s = game.state
    expect(s.phase).toBe('aiming')
    expect(s.score).toBe(0)
    expect(s.level).toBe(1)
    expect(s.combo).toBe(0)
    expect(s.chain).toBe(0)
    expect(s.elapsed).toBe(0)
    expect(s.riseTimer).toBe(RISE_START)
    expect(s.riseInterval).toBe(RISE_START)
    expect(s.aimAngle).toBe(0)
    expect(s.danger).toBe(false)
    expect(stackTopRow(s.grid)).toBe(ROWS - 4)
    expect(filledCount(s.grid)).toBeGreaterThan(0)
  })

  it('clamps aiming and only aims while aiming', () => {
    const game = createGame({ seed: 5 })
    game.setAim(10)
    expect(game.state.aimAngle).toBeCloseTo(MAX_AIM_ANGLE, 10)
    game.setAim(-10)
    expect(game.state.aimAngle).toBeCloseTo(-MAX_AIM_ANGLE, 10)
    game.setAim(0)
    game.aimBy(0.5)
    expect(game.state.aimAngle).toBeCloseTo(0.5, 10)
    game.aimBy(5)
    expect(game.state.aimAngle).toBeCloseTo(MAX_AIM_ANGLE, 10)

    game.setAim(0)
    game.launch()
    expect(game.state.phase).toBe('flying')
    game.setAim(1)
    expect(game.state.aimAngle).toBe(0)
  })
})

interface FuzzResult {
  locks: number
  gameOvers: number
  /** Every distinct cell count that was locked, so giants can be spotted. */
  sizes: Set<number>
}

/**
 * Fires random launches at fresh games over and over, checking that every lock
 * lands inside the board on free, distinct cells. With `giant` the pentomino
 * hazard is kept running so the oversized pieces get the same treatment.
 */
function fuzzLaunches(seed: number, count: number, giant: boolean): FuzzResult {
  const rng = createRng(seed)
  const sizes = new Set<number>()
  let before: Grid = []
  let locks = 0
  let gameOvers = 0

  const start = (): Game => {
    const g = createGame({ seed: rng.int(1 << 30) })
    if (giant) forceHazard(g, 'giant')
    before = cloneGrid(g.state.grid)
    g.events.on('impact', () => {
      before = cloneGrid(g.state.grid)
    })
    g.events.on('lock', ({ cells }: { cells: PlacedCell[] }) => {
      locks++
      sizes.add(cells.length)
      const seen = new Set<string>()
      for (const cell of cells) {
        expect(cell.col).toBeGreaterThanOrEqual(0)
        expect(cell.col).toBeLessThan(COLS)
        expect(cell.row).toBeLessThan(ROWS)
        const key = `${cell.row},${cell.col}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)
        if (cell.row >= 0) expect(before[cell.row][cell.col]).toBeNull()
      }
    })
    return g
  }

  let game = start()
  for (let i = 0; i < count; i++) {
    const angle = (rng.next() * 2 - 1) * MAX_AIM_ANGLE
    const frames = runLaunch(game, angle, 600)
    expect(frames).toBeLessThan(600)
    expect(['aiming', 'gameover']).toContain(game.state.phase)

    for (let r = 0; r < ROWS; r++) {
      expect(game.state.grid[r].length).toBe(COLS)
      expect(game.state.armor[r].length).toBe(COLS)
      for (let c = 0; c < COLS; c++) {
        const cell = game.state.grid[r][c]
        if (cell !== null) expect(cell).toBeGreaterThanOrEqual(0)
        if (cell !== null) expect(cell).toBeLessThan(4)
        // Armour never lingers on an empty cell.
        if (cell === null) expect(game.state.armor[r][c]).toBe(0)
      }
    }

    if (game.state.phase === 'gameover') {
      gameOvers++
      game = start()
    }
  }
  return { locks, gameOvers, sizes }
}

describe('flight, snap and lock', () => {
  it('locks pieces inside the board without ever overlapping (fuzz)', () => {
    const plain = fuzzLaunches(0xc0ffee, 400, false)
    expect(plain.locks).toBeGreaterThan(300)
    expect(plain.sizes.has(4)).toBe(true)

    // The same treatment for the pentominoes the `giant` hazard deals.
    const giants = fuzzLaunches(0xb16, 400, true)
    expect(giants.locks).toBeGreaterThan(300)
    expect(giants.sizes.has(5)).toBe(true)

    expect(plain.gameOvers + giants.gameOvers).toBeGreaterThan(0)
  })

  it('bounces off the side walls and reports the contact', () => {
    const game = createGame({ seed: 42 })
    clearGrid(game.state.grid)
    game.state.riseTimer = 999
    const bounces: Array<{ x: number; y: number }> = []
    game.events.on('bounce', (p) => bounces.push({ x: p.x, y: p.y }))

    runLaunch(game, MAX_AIM_ANGLE)
    expect(bounces.length).toBeGreaterThan(0)
    for (const b of bounces) {
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x).toBeLessThanOrEqual(COLS)
      expect(b.y).toBeGreaterThan(0)
      expect(b.y).toBeLessThan(ROWS)
    }
    // No duplicate contacts at the very same point.
    for (let i = 1; i < bounces.length; i++) {
      expect(Math.abs(bounces[i].y - bounces[i - 1].y)).toBeGreaterThan(1e-6)
    }
  })

  it('drops straight down onto the floor at angle 0', () => {
    const game = createGame({ seed: 3 })
    clearGrid(game.state.grid)
    game.state.riseTimer = 999
    game.state.current = { kind: 'O', rot: 0, colors: [0, 0, 1, 1] }

    let locked: PlacedCell[] = []
    game.events.on('lock', ({ cells }) => {
      locked = cells
    })
    runLaunch(game, 0)
    const rows = locked.map((c) => c.row).sort()
    const cols = locked.map((c) => c.col).sort()
    expect(rows).toEqual([ROWS - 2, ROWS - 2, ROWS - 1, ROWS - 1])
    expect(cols).toEqual([5, 5, 6, 6])
  })

  it('rotates while aiming and while flying, but not under lockRotate', () => {
    const game = createGame({ seed: 8 })
    clearGrid(game.state.grid)
    game.state.riseTimer = 999
    let rotations = 0
    game.events.on('rotate', () => rotations++)

    const rot0 = game.state.current.rot
    game.rotate(1)
    expect(game.state.current.rot).toBe((rot0 + 1) % 4)
    game.launch()
    const flyRot = game.state.flying?.piece.rot
    game.rotate(-1)
    expect(game.state.flying?.piece.rot).toBe(((flyRot ?? 0) + 3) % 4)
    expect(rotations).toBe(2)

    while (game.state.phase !== 'aiming') game.update(FRAME)
    game.applyCurse('lockRotate')
    const locked = game.state.current.rot
    game.rotate(1)
    expect(game.state.current.rot).toBe(locked)
    expect(rotations).toBe(2)
  })
})

describe('scoring and cascades', () => {
  /**
   * col 3/4 hold a red pair over a blue pair; a vertical piece dropped in col 5
   * completes the reds, then the blues fall together into a second match.
   */
  function chainBoard(): Game {
    const game = createGame({ seed: 11 })
    clearGrid(game.state.grid)
    game.state.riseTimer = 999
    game.state.grid[ROWS - 1][3] = 0
    game.state.grid[ROWS - 1][4] = 0
    game.state.grid[ROWS - 2][3] = 1
    game.state.grid[ROWS - 2][4] = 1
    game.state.current = { kind: 'I', rot: 1, colors: [1, 1, 0, 0] }
    return game
  }

  it('runs a 2-chain with the chain multiplier applied', () => {
    const game = chainBoard()
    const chainSteps: number[] = []
    const clears: number[] = []
    game.events.on('chainStep', ({ chain }) => chainSteps.push(chain))
    game.events.on('clear', (info) => clears.push(info.score))

    runLaunch(game, 0)

    expect(clears.length).toBe(2)
    expect(chainSteps).toEqual([2])
    expect(clears[0]).toBe(40 * 4 * 1)
    expect(clears[1]).toBe(40 * 4 * 2)
    expect(game.state.score).toBe(480)
    expect(game.state.chain).toBe(0)
    expect(game.state.combo).toBe(1)
    expect(game.state.clearsTotal).toBe(2)
    expect(filledCount(game.state.grid)).toBe(0)
  })

  it('spaces cascade steps by RESOLVE_STEP', () => {
    const game = chainBoard()
    const times: number[] = []
    game.events.on('clear', () => times.push(game.state.elapsed))
    runLaunch(game, 0)
    expect(times.length).toBe(2)
    expect(times[1] - times[0]).toBeGreaterThan(0.2)
    expect(times[1] - times[0]).toBeLessThan(0.3)
  })

  it('scores a full line clear', () => {
    const game = createGame({ seed: 21 })
    clearGrid(game.state.grid)
    game.state.riseTimer = 999
    const bottom: Array<CellColor | null> = [0, 1, 0, 1, 0, null, 1, 0, 1, 0, 1]
    for (let c = 0; c < COLS; c++) game.state.grid[ROWS - 1][c] = bottom[c]
    game.state.current = { kind: 'I', rot: 1, colors: [3, 3, 2, 2] }

    const clears: Array<{ lines: number[]; score: number }> = []
    game.events.on('clear', (info) => clears.push({ lines: info.lines, score: info.score }))

    runLaunch(game, 0)
    expect(clears.length).toBe(1)
    expect(clears[0].lines).toEqual([ROWS - 1])
    expect(clears[0].score).toBe(120)
    expect(game.state.score).toBe(120)
    expect(game.state.clearsTotal).toBe(1)
    expect(game.state.combo).toBe(1)
  })

  it('resets the combo when a launch clears nothing', () => {
    const game = createGame({ seed: 21 })
    clearGrid(game.state.grid)
    game.state.riseTimer = 999
    game.state.combo = 4
    runLaunch(game, 0)
    expect(game.state.combo).toBe(0)
  })

  it('levels up every CLEARS_PER_LEVEL clears', () => {
    const game = createGame({ seed: 31 })
    clearGrid(game.state.grid)
    game.state.riseTimer = 999
    game.state.clearsTotal = CLEARS_PER_LEVEL * 2 - 1
    const levels: number[] = []
    game.events.on('levelUp', ({ level }) => levels.push(level))

    // One guaranteed match: two reds waiting for a third.
    game.state.grid[ROWS - 1][4] = 0
    game.state.grid[ROWS - 1][6] = 0
    game.state.current = { kind: 'I', rot: 1, colors: [1, 1, 0, 0] }
    runLaunch(game, 0)

    expect(game.state.clearsTotal).toBe(CLEARS_PER_LEVEL * 2)
    expect(levels).toEqual([3])
    expect(game.state.level).toBe(3)
  })
})

describe('rise and death', () => {
  it('inserts a garbage row and pushes the stack up', () => {
    const game = createGame({ seed: 4 })
    clearGrid(game.state.grid)
    game.state.grid[ROWS - 1][0] = 2
    game.state.riseTimer = 0.01

    let rises = 0
    let warnings = 0
    game.events.on('rise', ({ rows }) => {
      rises += rows
    })
    game.events.on('riseWarning', () => warnings++)

    game.update(0.02)
    expect(rises).toBe(1)
    expect(warnings).toBe(1)
    expect(game.state.grid[ROWS - 2][0]).toBe(2)
    expect(filledCount(game.state.grid)).toBeGreaterThan(1)

    const expected = RISE_MIN + (RISE_START - RISE_MIN) * Math.exp(-game.state.elapsed / RISE_TAU)
    expect(game.state.riseInterval).toBeCloseTo(expected, 10)
    expect(game.state.riseTimer).toBeCloseTo(expected, 10)
  })

  it('does not tick the rise timer while resolving', () => {
    const game = createGame({ seed: 12 })
    clearGrid(game.state.grid)
    game.state.riseTimer = 999
    game.state.grid[ROWS - 1][4] = 0
    game.state.grid[ROWS - 1][6] = 0
    game.state.current = { kind: 'I', rot: 1, colors: [1, 1, 0, 0] }

    game.setAim(0)
    game.launch()
    while (game.state.phase === 'flying') game.update(FRAME)
    expect(game.state.phase).toBe('resolving')

    const timer = game.state.riseTimer
    game.update(0.1)
    expect(game.state.riseTimer).toBe(timer)
  })

  it('fires gameOver exactly once when the stack reaches the kill zone', () => {
    const game = createGame({ seed: 6 })
    clearGrid(game.state.grid)
    for (let r = TOP_KILL_ROW; r < ROWS; r++) game.state.grid[r][0] = 1
    game.state.riseTimer = 0.01

    let overs = 0
    let lastScore = -1
    game.events.on('gameOver', ({ score }) => {
      overs++
      lastScore = score
    })

    game.update(0.02)
    expect(game.state.phase).toBe('gameover')
    expect(overs).toBe(1)
    expect(lastScore).toBe(game.state.score)

    for (let i = 0; i < 10; i++) game.update(FRAME)
    game.addGarbage(3)
    game.applyCurse('garbage')
    expect(overs).toBe(1)

    // The engine is inert afterwards.
    const snapshot = game.serialize()
    game.launch()
    game.update(1)
    expect(game.state.phase).toBe('gameover')
    expect(game.serialize().grid).toEqual(snapshot.grid)
  })

  it('toggles the danger flag only on change', () => {
    const game = createGame({ seed: 7 })
    clearGrid(game.state.grid)
    const events: boolean[] = []
    game.events.on('danger', ({ on }) => events.push(on))

    expect(game.state.danger).toBe(false)
    for (let r = TOP_KILL_ROW + 1; r < ROWS; r++) game.state.grid[r][2] = 0
    game.state.riseTimer = 0.01
    game.update(0.02)
    expect(game.state.danger).toBe(true)
    expect(events).toEqual([true])

    game.state.riseTimer = 0.01
    game.update(0.02)
    expect(events).toEqual([true])
  })
})

describe('difficulty', () => {
  /** Forces one rise so the engine publishes the interval it just computed. */
  function intervalAt(difficulty: Difficulty, elapsed: number, level: number): number {
    const game = createGame({ seed: 1, difficulty })
    quiet(game)
    game.state.elapsed = elapsed
    game.state.level = level
    game.state.riseTimer = 1e-9
    game.update(1e-9)
    return game.state.riseInterval
  }

  /** Drops one piece into the single gap of an otherwise full bottom row. */
  function lineClearGame(difficulty: Difficulty): Game {
    const game = createGame({ seed: 21, difficulty })
    quiet(game)
    const bottom: Array<CellColor | null> = [0, 1, 0, 1, 0, null, 1, 0, 1, 0, 1]
    for (let c = 0; c < COLS; c++) game.state.grid[ROWS - 1][c] = bottom[c]
    game.state.current = { kind: 'I', rot: 1, colors: [3, 3, 2, 2] }
    return game
  }

  it('mirrors the chosen tier onto the state', () => {
    for (const id of DIFFICULTY_ORDER) {
      const cfg = DIFFICULTIES[id]
      const game = createGame({ seed: 5, difficulty: id })
      expect(game.state.difficulty).toBe(id)
      expect(game.state.riseTimer).toBe(cfg.riseStart)
      expect(game.state.riseInterval).toBe(cfg.riseStart)
      expect(stackTopRow(game.state.grid)).toBe(ROWS - cfg.initialRows)
      expect(game.state.colorsLocked).toBe(cfg.stoneOnly)
      expect(game.state.hazards).toEqual([])
      expect(game.state.hazardTimer).toBe(cfg.hazardEvery > 0 ? cfg.hazardEvery : Infinity)
    }
  })

  it('defaults to normal, whose numbers are the legacy constants', () => {
    const game = createGame({ seed: 5 })
    expect(game.state.difficulty).toBe('normal')
    expect(DIFFICULTIES.normal.riseStart).toBe(RISE_START)
    expect(DIFFICULTIES.normal.riseMin).toBe(RISE_MIN)
    expect(DIFFICULTIES.normal.riseTau).toBe(RISE_TAU)
    expect(DIFFICULTIES.normal.clearsPerLevel).toBe(CLEARS_PER_LEVEL)
  })

  it('rises strictly sooner on every harder tier, at any elapsed and level', () => {
    for (const elapsed of [0, 30, 120, 300]) {
      for (const level of [1, 2, 4, 6]) {
        const intervals = DIFFICULTY_ORDER.map((d) => intervalAt(d, elapsed, level))
        for (let i = 1; i < intervals.length; i++) {
          expect(intervals[i]).toBeLessThan(intervals[i - 1])
        }
      }
    }
  })

  it('shrinks the interval as the level climbs, and as time passes', () => {
    for (const d of DIFFICULTY_ORDER) {
      const l1 = intervalAt(d, 60, 1)
      const l3 = intervalAt(d, 60, 3)
      const l6 = intervalAt(d, 60, 6)
      expect(l3).toBeLessThan(l1)
      expect(l6).toBeLessThan(l3)
      expect(l6).toBeGreaterThanOrEqual(RISE_FLOOR)
      expect(intervalAt(d, 300, 1)).toBeLessThan(l1)
    }
  })

  it('matches the documented curve and never dips below the floor', () => {
    for (const d of DIFFICULTY_ORDER) {
      const cfg = DIFFICULTIES[d]
      const elapsed = 90
      const level = 4
      const base = cfg.riseMin + (cfg.riseStart - cfg.riseMin) * Math.exp(-elapsed / cfg.riseTau)
      const expected = Math.max(RISE_FLOOR, base * Math.pow(cfg.riseLevelFactor, level - 1))
      expect(intervalAt(d, elapsed, level)).toBeCloseTo(expected, 6)
      expect(intervalAt(d, 5000, 500)).toBe(RISE_FLOOR)
    }
  })

  it('scales score by the tier multiplier', () => {
    for (const d of DIFFICULTY_ORDER) {
      const game = lineClearGame(d)
      runLaunch(game, 0)
      expect(game.state.score).toBe(Math.round(120 * DIFFICULTIES[d].scoreScale))
      expect(game.state.clearsTotal).toBe(1)
    }
  })

  it('levels up on the tier cadence', () => {
    for (const d of DIFFICULTY_ORDER) {
      const game = lineClearGame(d)
      game.state.clearsTotal = DIFFICULTIES[d].clearsPerLevel * 2 - 1
      game.state.level = 2
      const levels: number[] = []
      game.events.on('levelUp', ({ level }) => levels.push(level))
      runLaunch(game, 0)
      expect(game.state.clearsTotal).toBe(DIFFICULTIES[d].clearsPerLevel * 2)
      expect(levels).toEqual([3])
    }
  })
})

describe('hardcore / colorsLocked', () => {
  /** Two reds on the floor waiting for a vertical piece to complete them. */
  function matchGame(difficulty: Difficulty): Game {
    const game = createGame({ seed: 3, difficulty })
    quiet(game)
    game.state.grid[ROWS - 1][4] = 0
    game.state.grid[ROWS - 1][6] = 0
    game.state.current = { kind: 'I', rot: 1, colors: [1, 1, 0, 0] }
    return game
  }

  it('locks colours from the start', () => {
    expect(createGame({ seed: 3, difficulty: 'hardcore' }).state.colorsLocked).toBe(true)
    expect(createGame({ seed: 3, difficulty: 'hard' }).state.colorsLocked).toBe(false)
  })

  it('never applies findMatches: an obvious colour match does not clear', () => {
    const game = matchGame('hardcore')
    let clears = 0
    game.events.on('clear', () => clears++)
    runLaunch(game, 0)

    expect(clears).toBe(0)
    expect(game.state.score).toBe(0)
    expect(game.state.clearsTotal).toBe(0)
    expect(game.state.combo).toBe(0)
    expect(filledCount(game.state.grid)).toBe(6)
    // Same board, colours live: it clears.
    const normal = matchGame('normal')
    runLaunch(normal, 0)
    expect(normal.state.score).toBeGreaterThan(0)
  })

  it('keeps the stored colours so the blocks are only painted as stone', () => {
    const game = matchGame('hardcore')
    runLaunch(game, 0)
    expect(game.state.grid[ROWS - 1][4]).toBe(0)
    expect(game.state.grid[ROWS - 1][5]).toBe(0)
    expect(game.state.grid[ROWS - 1][6]).toBe(0)
  })

  it('still clears full lines, which is all hardcore has', () => {
    const game = createGame({ seed: 21, difficulty: 'hardcore' })
    quiet(game)
    const bottom: Array<CellColor | null> = [0, 1, 0, 1, 0, null, 1, 0, 1, 0, 1]
    for (let c = 0; c < COLS; c++) game.state.grid[ROWS - 1][c] = bottom[c]
    game.state.current = { kind: 'I', rot: 1, colors: [3, 3, 2, 2] }

    const cleared: number[][] = []
    game.events.on('clear', (info) => cleared.push(info.lines))
    runLaunch(game, 0)
    expect(cleared).toEqual([[ROWS - 1]])
    expect(game.state.score).toBe(Math.round(120 * DIFFICULTIES.hardcore.scoreScale))
  })
})

describe('armour', () => {
  it('absorbs a clear, reports the hit, and breaks on the next one', () => {
    const game = createGame({ seed: 41 })
    quiet(game)
    game.state.grid[ROWS - 1][4] = 0
    game.state.armor[ROWS - 1][4] = 1
    game.state.grid[ROWS - 1][6] = 0
    game.state.current = { kind: 'I', rot: 1, colors: [1, 1, 0, 0] }

    const hits: Array<{ row: number; col: number; remaining: number }> = []
    game.events.on('armorHit', (h) => hits.push({ ...h }))
    const clears: Array<{ lines: number[]; score: number }> = []
    game.events.on('clear', (info) => clears.push({ lines: info.lines, score: info.score }))

    runLaunch(game, 0)

    expect(hits).toEqual([{ row: ROWS - 1, col: 4, remaining: 0 }])
    // The armoured block stayed put; only the three bare cells broke.
    expect(game.state.grid[ROWS - 1][4]).toBe(0)
    expect(game.state.armor[ROWS - 1][4]).toBe(0)
    expect(clears).toHaveLength(1)
    expect(clears[0].score).toBe(40 * 3)
    expect(game.state.clearsTotal).toBe(1)

    // Second pass over the same, now unarmoured, block.
    clearGrid(game.state.grid)
    game.state.grid[ROWS - 1][4] = 0
    game.state.grid[ROWS - 1][6] = 0
    game.state.current = { kind: 'I', rot: 1, colors: [1, 1, 0, 0] }
    runLaunch(game, 0)

    expect(hits).toHaveLength(1)
    expect(game.state.grid[ROWS - 1][4]).toBeNull()
    expect(clears).toHaveLength(2)
    expect(clears[1].score).toBe(40 * 4 * (1 + 0.1))
  })

  it('a fully armoured line takes damage instead of clearing', () => {
    const game = createGame({ seed: 42 })
    quiet(game)
    for (let c = 0; c < COLS; c++) {
      if (c === 5) continue
      game.state.grid[ROWS - 1][c] = (c % 2) as CellColor
      game.state.armor[ROWS - 1][c] = 1
    }
    game.state.current = { kind: 'I', rot: 1, colors: [3, 3, 2, 2], armor: 1 }

    const hitCols: number[] = []
    game.events.on('armorHit', ({ col }) => hitCols.push(col))
    let clears = 0
    game.events.on('clear', () => clears++)

    const filledBefore = filledCount(game.state.grid) + 4
    runLaunch(game, 0)

    expect(clears).toBe(0)
    expect(game.state.score).toBe(0)
    expect(game.state.clearsTotal).toBe(0)
    expect(filledCount(game.state.grid)).toBe(filledBefore)
    // The row is still full — it simply lost its armour, and clears next pass.
    expect(findLines(game.state.grid)).toEqual([ROWS - 1])
    expect(hitCols.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    for (let c = 0; c < COLS; c++) expect(game.state.armor[ROWS - 1][c]).toBe(0)
    expect(game.state.phase).toBe('aiming')
  })

  it('always terminates the cascade when every candidate cell is armoured', () => {
    const game = createGame({ seed: 43 })
    quiet(game)
    for (let r = ROWS - 3; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        // A checkerboard, so only line clears are ever on the table.
        game.state.grid[r][c] = ((r + c) % 2) as CellColor
        game.state.armor[r][c] = 1
      }
    }

    const clears: number[][] = []
    game.events.on('clear', (info) => clears.push(info.lines))

    game.state.current = { kind: 'O', rot: 0, colors: [2, 2, 3, 3] }
    expect(runLaunch(game, 0, 3000)).toBeLessThan(3000)
    expect(game.state.phase).toBe('aiming')
    expect(clears).toEqual([])

    // Nothing keeps ticking us back into a resolve either.
    for (let i = 0; i < 30 * 60; i++) {
      game.state.riseTimer = 1e6
      game.update(FRAME)
    }
    expect(game.state.phase).toBe('aiming')

    // Armour is spent now, so the very next resolve clears the three lines.
    game.state.current = { kind: 'O', rot: 0, colors: [2, 2, 3, 3] }
    expect(runLaunch(game, 0, 3000)).toBeLessThan(3000)
    expect(game.state.phase).toBe('aiming')
    expect(clears).toHaveLength(1)
    expect(clears[0]).toEqual([ROWS - 3, ROWS - 2, ROWS - 1])
    expect(findLines(game.state.grid)).toEqual([])
  })

  it('moves in lockstep with the grid through rises and gravity', () => {
    const game = createGame({ seed: 44 })
    quiet(game)
    game.state.grid[ROWS - 1][2] = 1
    game.state.armor[ROWS - 1][2] = 2

    game.addGarbage(1)
    expect(game.state.grid[ROWS - 2][2]).toBe(1)
    expect(game.state.armor[ROWS - 2][2]).toBe(2)
    for (let c = 0; c < COLS; c++) expect(game.state.armor[ROWS - 1][c]).toBe(0)

    // A scramble re-rolls colours only; armour is not its business.
    const armorBefore = game.state.armor.map((row) => row.slice())
    game.applyCurse('scramble')
    expect(game.state.armor).toEqual(armorBefore)
  })

  it('lands a piece with the armour it was dealt', () => {
    const game = createGame({ seed: 45 })
    quiet(game)
    game.state.current = { kind: 'O', rot: 0, colors: [0, 0, 1, 1], armor: 1 }
    let locked: PlacedCell[] = []
    game.events.on('lock', ({ cells }) => {
      locked = cells
    })
    runLaunch(game, 0)
    expect(locked).toHaveLength(4)
    for (const cell of locked) expect(game.state.armor[cell.row][cell.col]).toBe(1)
  })
})

describe('hazards', () => {
  it('rolls deterministically per seed, one at a time, never repeating', () => {
    function run(seed: number): { kinds: HazardKind[]; maxConcurrent: number } {
      const game = createGame({ seed })
      clearGrid(game.state.grid)
      const kinds: HazardKind[] = []
      game.events.on('hazardStart', ({ kind }) => kinds.push(kind))
      let maxConcurrent = 0
      for (let i = 0; i < 12000; i++) {
        game.state.riseTimer = 1e6
        game.update(0.05)
        if (game.state.hazards.length > maxConcurrent) maxConcurrent = game.state.hazards.length
      }
      return { kinds, maxConcurrent }
    }

    const a = run(808)
    expect(a.kinds.length).toBeGreaterThan(5)
    expect(a.maxConcurrent).toBe(1)
    for (const kind of a.kinds) expect(HAZARD_KINDS).toContain(kind)
    for (let i = 1; i < a.kinds.length; i++) expect(a.kinds[i]).not.toBe(a.kinds[i - 1])
    expect(new Set(a.kinds).size).toBeGreaterThan(1)

    expect(run(808).kinds).toEqual(a.kinds)
    expect(run(4242).kinds).not.toEqual(a.kinds)
  })

  it('expires after HAZARD_DURATION and hands the state back', () => {
    const game = createGame({ seed: 909 })
    clearGrid(game.state.grid)
    const starts: Array<{ kind: HazardKind; at: number }> = []
    const ends: Array<{ kind: HazardKind; at: number }> = []
    game.events.on('hazardStart', ({ kind }) => starts.push({ kind, at: game.state.elapsed }))
    game.events.on('hazardEnd', ({ kind }) => ends.push({ kind, at: game.state.elapsed }))

    idle(game, 200, 0.02)
    expect(starts.length).toBeGreaterThan(1)
    expect(ends).toHaveLength(starts.length)
    for (let i = 0; i < ends.length; i++) {
      expect(ends[i].kind).toBe(starts[i].kind)
      expect(ends[i].at - starts[i].at).toBeCloseTo(HAZARD_DURATION[starts[i].kind], 1)
    }
    expect(game.state.hazards).toEqual([])
    expect(game.state.colorsLocked).toBe(false)
  })

  it('never rolls in versus, and never when the tier disables them', () => {
    for (const game of [
      createGame({ seed: 808, versus: true }),
      createGame({ seed: 808, difficulty: 'chill' }),
    ]) {
      clearGrid(game.state.grid)
      let starts = 0
      game.events.on('hazardStart', () => starts++)
      expect(game.state.hazardTimer).toBe(Infinity)
      idle(game, 400)
      expect(starts).toBe(0)
      expect(game.state.hazards).toEqual([])
      expect(game.state.hazardTimer).toBe(Infinity)
    }
  })

  it('stone kills colour matching while it runs, and gives it back after', () => {
    const game = createGame({ seed: 79 })
    quiet(game)
    expect(game.state.colorsLocked).toBe(false)
    forceHazard(game, 'stone', 60)

    game.state.grid[ROWS - 1][4] = 0
    game.state.grid[ROWS - 1][6] = 0
    game.state.current = { kind: 'I', rot: 1, colors: [1, 1, 0, 0] }
    runLaunch(game, 0)
    expect(game.state.score).toBe(0)
    expect(filledCount(game.state.grid)).toBe(6)

    const ended: HazardKind[] = []
    game.events.on('hazardEnd', ({ kind }) => ended.push(kind))
    game.state.hazards[0].remaining = 0.01
    game.state.riseTimer = 1e6
    game.update(FRAME)
    expect(ended).toEqual(['stone'])
    expect(game.state.colorsLocked).toBe(false)

    // The colours were never touched, so the waiting match resolves at once.
    game.state.current = { kind: 'O', rot: 0, colors: [3, 3, 2, 2] }
    runLaunch(game, 0)
    expect(game.state.score).toBeGreaterThan(0)
    expect(game.state.grid[ROWS - 1][4]).toBeNull()
  })

  it('armor deals pieces that land with HAZARD_ARMOR', () => {
    const game = createGame({ seed: 78 })
    quiet(game)
    forceHazard(game, 'armor')
    runLaunch(game, 0)
    expect(game.state.next.armor).toBe(HAZARD_ARMOR)
    runLaunch(game, 0)
    expect(game.state.current.armor).toBe(HAZARD_ARMOR)
  })

  it('giant deals 5-cell pieces that lock cleanly, and leaves the bag alone', () => {
    // The third piece the 7-bag would hand out, with no hazard in the way.
    const plain = createGame({ seed: 77 })
    quiet(plain)
    runLaunch(plain, 0.4)
    const thirdFromBag = pieceSignature(plain.state.next)

    const game = createGame({ seed: 77 })
    quiet(game)
    forceHazard(game, 'giant')
    const sizes = new Set<number>()
    const kinds: string[] = []

    for (let i = 0; i < 8; i++) {
      const kind = game.state.current.kind
      let locked: PlacedCell[] = []
      const off = game.events.on('lock', ({ cells }) => {
        locked = cells
      })
      runLaunch(game, 0.4)
      off()
      quiet(game)

      // Two tetrominoes were already in hand when the hazard landed.
      if (i >= 2) {
        kinds.push(kind)
        sizes.add(locked.length)
      }
      const seen = new Set<string>()
      for (const cell of locked) {
        expect(cell.row).toBeGreaterThanOrEqual(0)
        expect(cell.row).toBeLessThan(ROWS)
        expect(cell.col).toBeGreaterThanOrEqual(0)
        expect(cell.col).toBeLessThan(COLS)
        const key = `${cell.row},${cell.col}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
      expect(pieceCells(game.state.next, 5.5, 5.5)).toHaveLength(game.state.next.colors.length)
    }

    expect([...sizes]).toEqual([5])
    for (const kind of kinds) expect(BIG_PIECE_KINDS).toContain(kind)

    // The 7-bag never noticed: dropping the hazard resumes the same stream.
    game.state.hazards.length = 0
    runLaunch(game, 0.4)
    expect(pieceSignature(game.state.next)).toBe(thirdFromBag)
  })

  it('rush doubles the rise clock and stacks with the speed curse', () => {
    const start = DIFFICULTIES.normal.riseStart
    const plain = createGame({ seed: 16 })
    plain.update(1)
    const unit = start - plain.state.riseTimer

    const rushed = createGame({ seed: 16 })
    forceHazard(rushed, 'rush')
    rushed.update(1)
    expect(start - rushed.state.riseTimer).toBeCloseTo(2 * unit, 6)

    const both = createGame({ seed: 16 })
    forceHazard(both, 'rush')
    both.applyCurse('speed')
    both.update(1)
    expect(start - both.state.riseTimer).toBeCloseTo(4 * unit, 6)
  })
})

describe('curses', () => {
  it('garbage adds two rows immediately', () => {
    const game = createGame({ seed: 15 })
    const top = stackTopRow(game.state.grid)
    game.applyCurse('garbage')
    expect(stackTopRow(game.state.grid)).toBe(top - 2)
    expect(game.state.activeCurses.length).toBe(0)
  })

  it('speed halves the rise interval while active', () => {
    const plain = createGame({ seed: 16 })
    const fast = createGame({ seed: 16 })
    fast.applyCurse('speed')
    plain.update(1)
    fast.update(1)
    expect(RISE_START - fast.state.riseTimer).toBeCloseTo(2 * (RISE_START - plain.state.riseTimer), 6)
    expect(fast.state.activeCurses[0]).toEqual({ kind: 'speed', remaining: CURSE_DURATION.speed - 1 })
  })

  it('scramble re-rolls colors without changing occupancy', () => {
    const game = createGame({ seed: 17 })
    clearGrid(game.state.grid)
    for (let r = ROWS - 3; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) game.state.grid[r][c] = 0
    }
    const beforeFilled = filledCount(game.state.grid)
    game.applyCurse('scramble')
    expect(filledCount(game.state.grid)).toBe(beforeFilled)

    let changed = 0
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) if (game.state.grid[r][c] !== null && game.state.grid[r][c] !== 0) changed++
    }
    expect(changed).toBeGreaterThan(0)
  })

  it('fog and mirror are pure timed flags that expire', () => {
    const game = createGame({ seed: 18 })
    const applied: CurseKind[] = []
    const expired: CurseKind[] = []
    game.events.on('curseApplied', ({ kind }) => applied.push(kind))
    game.events.on('curseExpired', ({ kind }) => expired.push(kind))

    const gridBefore = cloneGrid(game.state.grid)
    game.applyCurse('fog')
    game.applyCurse('mirror')
    expect(game.state.grid).toEqual(gridBefore)
    expect(game.state.activeCurses.map((c) => c.kind).sort()).toEqual(['fog', 'mirror'])

    game.state.riseTimer = 1e6
    for (let i = 0; i < 11 * 60; i++) game.update(FRAME)
    expect(expired).toContain('mirror')
    expect(expired).not.toContain('fog')
    for (let i = 0; i < 2 * 60; i++) game.update(FRAME)
    expect(expired.sort()).toEqual(['fog', 'mirror'])
    expect(game.state.activeCurses.length).toBe(0)
    expect(applied).toEqual(['fog', 'mirror'])
  })

  it('re-applying a timed curse refreshes its duration', () => {
    const game = createGame({ seed: 19 })
    game.state.riseTimer = 1e6
    game.applyCurse('fog')
    for (let i = 0; i < 60; i++) game.update(FRAME)
    expect(game.state.activeCurses[0].remaining).toBeLessThan(CURSE_DURATION.fog)
    game.applyCurse('fog')
    expect(game.state.activeCurses.length).toBe(1)
    expect(game.state.activeCurses[0].remaining).toBe(CURSE_DURATION.fog)
  })

  it('lockRotate blocks rotation until it expires', () => {
    const game = createGame({ seed: 20 })
    game.state.riseTimer = 1e6
    game.applyCurse('lockRotate')
    const rot = game.state.current.rot
    game.rotate(1)
    expect(game.state.current.rot).toBe(rot)
    for (let i = 0; i < 11 * 60; i++) game.update(FRAME)
    game.rotate(1)
    expect(game.state.current.rot).toBe((rot + 1) % 4)
  })
})

describe('versus powers', () => {
  it('catches a bubble in flight and hands it out FIFO', () => {
    const game = createGame({ seed: 23, versus: true })
    clearGrid(game.state.grid)
    game.state.riseTimer = 999
    game.state.powers.push({ id: 1, kind: 'fog', x: 5.5, y: 10, age: 0 })

    const caught: CurseKind[] = []
    game.events.on('powerCaught', ({ kind }) => caught.push(kind))
    runLaunch(game, 0)

    expect(caught).toEqual(['fog'])
    expect(game.state.powers.length).toBe(0)
    expect(game.state.inventory).toEqual(['fog'])

    game.state.inventory.push('speed')
    expect(game.useCurse()).toBe('fog')
    expect(game.useCurse()).toBe('speed')
    expect(game.useCurse()).toBeNull()
  })

  it('ignores bubbles when the inventory is full', () => {
    const game = createGame({ seed: 24, versus: true })
    clearGrid(game.state.grid)
    game.state.riseTimer = 999
    for (let i = 0; i < MAX_INVENTORY; i++) game.state.inventory.push('fog')
    game.state.powers.push({ id: 1, kind: 'mirror', x: 5.5, y: 10, age: 0 })
    runLaunch(game, 0)
    expect(game.state.powers.length).toBe(1)
    expect(game.state.inventory.length).toBe(MAX_INVENTORY)
  })

  it('floats bubbles upward and loses them above the board', () => {
    const game = createGame({ seed: 25, versus: true })
    game.state.riseTimer = 1e6
    game.state.powers.push({ id: 9, kind: 'garbage', x: 5.5, y: 4, age: 0 })
    const lost: number[] = []
    game.events.on('powerLost', ({ id }) => lost.push(id))

    let prevY = game.state.powers[0].y
    for (let i = 0; i < 60; i++) {
      game.update(FRAME)
      if (game.state.powers.length === 0) break
      expect(game.state.powers[0].y).toBeLessThan(prevY)
      expect(Math.abs(game.state.powers[0].x - 5.5)).toBeLessThanOrEqual(0.4001)
      prevY = game.state.powers[0].y
    }
    expect(lost).toEqual([])

    for (let i = 0; i < 300 && game.state.powers.length > 0; i++) game.update(FRAME)
    expect(lost).toEqual([9])
    expect(game.state.powers.length).toBe(0)
  })

  it('spawns bubbles on clears and never exceeds MAX_POWERS', () => {
    const game = createGame({ seed: 26, versus: true })
    let spawns = 0
    game.events.on('powerSpawn', ({ power }) => {
      spawns++
      expect(power.id).toBeGreaterThan(0)
      expect(power.x).toBeGreaterThanOrEqual(0)
      expect(power.x).toBeLessThanOrEqual(COLS)
    })

    const rng = createRng(4242)
    for (let i = 0; i < 120 && game.state.phase !== 'gameover'; i++) {
      runLaunch(game, (rng.next() * 2 - 1) * MAX_AIM_ANGLE)
      expect(game.state.powers.length).toBeLessThanOrEqual(MAX_POWERS)
      expect(game.state.inventory.length).toBeLessThanOrEqual(MAX_INVENTORY)
    }
    expect(spawns).toBeGreaterThan(0)
  })

  it('does not spawn bubbles in single player', () => {
    const game = createGame({ seed: 26 })
    let spawns = 0
    game.events.on('powerSpawn', () => spawns++)
    const rng = createRng(4242)
    for (let i = 0; i < 60 && game.state.phase !== 'gameover'; i++) {
      runLaunch(game, (rng.next() * 2 - 1) * MAX_AIM_ANGLE)
    }
    expect(spawns).toBe(0)
    expect(game.state.powers.length).toBe(0)
  })
})

describe('save & resume', () => {
  it('round-trips into an identical game with the same next 10 pieces', () => {
    const original = createGame({ seed: 90210 })
    const rng = createRng(5)
    for (let i = 0; i < 7; i++) runLaunch(original, (rng.next() * 2 - 1) * MAX_AIM_ANGLE)

    const save = original.serialize()
    expect(save.version).toBe(2)
    const resumed = loadGame(save)

    expect(resumed.state.phase).toBe('aiming')
    expect(resumed.serialize()).toEqual(save)
    expect(resumed.state.score).toBe(original.state.score)
    expect(resumed.state.level).toBe(original.state.level)
    expect(resumed.state.clearsTotal).toBe(original.state.clearsTotal)
    expect(resumed.state.grid).toEqual(original.state.grid)

    const angles = [0.1, -0.4, 0.8, -1.0, 0.5, 0, -0.2, 1.1, -0.9, 0.6]
    const seqA: string[] = []
    const seqB: string[] = []
    for (const angle of angles) {
      seqA.push(pieceSignature(original.state.current))
      seqB.push(pieceSignature(resumed.state.current))
      runLaunch(original, angle)
      runLaunch(resumed, angle)
    }
    expect(seqB).toEqual(seqA)
    expect(resumed.state.grid).toEqual(original.state.grid)
    expect(resumed.state.score).toBe(original.state.score)
  })

  it('round-trips difficulty, armour and hazards, pieces included', () => {
    const original = createGame({ seed: 4242, difficulty: 'hard' })
    const rng = createRng(9)
    for (let i = 0; i < 6; i++) runLaunch(original, (rng.next() * 2 - 1) * MAX_AIM_ANGLE)
    original.state.grid[ROWS - 1][0] = 1
    original.state.armor[ROWS - 1][0] = 2
    forceHazard(original, 'giant', 7.5)
    original.state.hazardTimer = 12.5

    const save = original.serialize()
    expect(save.version).toBe(2)
    expect(save.difficulty).toBe('hard')
    expect(save.armor).toHaveLength(ROWS * COLS)
    expect(save.armor[(ROWS - 1) * COLS]).toBe(2)
    expect(save.hazards).toEqual([{ kind: 'giant', remaining: 7.5 }])
    expect(save.hazardTimer).toBe(12.5)

    const resumed = loadGame(save)
    expect(resumed.state.difficulty).toBe('hard')
    expect(resumed.state.grid).toEqual(original.state.grid)
    expect(resumed.state.armor).toEqual(original.state.armor)
    expect(resumed.state.hazards).toEqual(original.state.hazards)
    expect(resumed.state.hazardTimer).toBe(12.5)
    expect(resumed.serialize()).toEqual(save)

    // The giants keep coming, in the same order, on both sides.
    const angles = [0.1, -0.4, 0.8, -1.0, 0.5, 0, -0.2, 1.1]
    const seqA: string[] = []
    const seqB: string[] = []
    for (const angle of angles) {
      seqA.push(pieceSignature(original.state.current))
      seqB.push(pieceSignature(resumed.state.current))
      runLaunch(original, angle)
      runLaunch(resumed, angle)
    }
    expect(seqB).toEqual(seqA)
    expect(resumed.state.grid).toEqual(original.state.grid)
    expect(resumed.state.armor).toEqual(original.state.armor)
    expect(resumed.state.score).toBe(original.state.score)
  })

  it('keeps a hazard-free tier hazard-free across a save', () => {
    const game = createGame({ seed: 12, difficulty: 'chill' })
    const save = game.serialize()
    expect(save.difficulty).toBe('chill')
    expect(save.hazards).toEqual([])
    expect(save.hazardTimer).toBe(Infinity)

    const resumed = loadGame(save)
    expect(resumed.state.difficulty).toBe('chill')
    expect(resumed.state.hazardTimer).toBe(Infinity)
    idle(resumed, 300)
    expect(resumed.state.hazards).toEqual([])
  })

  it('keeps saves independent from the live game', () => {
    const game = createGame({ seed: 3 })
    const save = game.serialize()
    const flat = save.grid.slice()
    game.addGarbage(2)
    game.rotate(1)
    expect(save.grid).toEqual(flat)
  })
})

describe('computeAimPath', () => {
  it('starts at the launcher and ends where the piece really lands', () => {
    const angles = [0, 0.25, -0.25, 0.6, -0.6, 0.95, -0.95, 1.2, -1.2, 0.42, -0.77]
    for (const seed of [1, 2, 3, 77, 1234]) {
      for (const angle of angles) {
        const game = createGame({ seed })
        game.state.riseTimer = 1e6
        game.setAim(angle)

        const path = computeAimPath(game.state)
        expect(path.length).toBeGreaterThanOrEqual(2)
        expect(path[0].x).toBeCloseTo(COLS / 2, 10)
        expect(path[0].y).toBeCloseTo(1, 10)

        const piece = game.state.current
        let locked: PlacedCell[] = []
        game.events.on('lock', ({ cells }) => {
          locked = cells
        })
        runLaunch(game, angle)

        const end = path[path.length - 1]
        const predicted = pieceCells(piece, end.x, end.y)
        expect(locked.map((c) => `${c.row},${c.col}`).sort()).toEqual(
          predicted.map((c) => `${c.row},${c.col}`).sort(),
        )
      }
    }
  })

  it('honours maxPoints and never leaves the board', () => {
    const game = createGame({ seed: 55 })
    game.state.riseTimer = 1e6
    game.setAim(MAX_AIM_ANGLE)
    const path = computeAimPath(game.state, 4)
    expect(path.length).toBeLessThanOrEqual(4)
    for (const p of path) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(COLS)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(ROWS)
    }
  })

  it('does not mutate the game state', () => {
    const game = createGame({ seed: 56 })
    game.setAim(0.7)
    const before = cloneGrid(game.state.grid)
    const snapshot = game.serialize()
    computeAimPath(game.state)
    expect(game.state.grid).toEqual(before)
    expect(game.serialize()).toEqual(snapshot)
    expect(game.state.phase).toBe('aiming')
  })
})

describe('event bus', () => {
  it('unsubscribes cleanly', () => {
    const game = createGame({ seed: 60 })
    let count = 0
    const off = game.events.on('launch', () => count++)
    game.setAim(0)
    game.launch()
    expect(count).toBe(1)
    off()
    while (game.state.phase !== 'aiming') game.update(FRAME)
    game.launch()
    expect(count).toBe(1)

    let other = 0
    game.events.on('launch', () => other++)
    game.events.clear()
    while (game.state.phase !== 'aiming') game.update(FRAME)
    game.launch()
    expect(other).toBe(0)
  })
})
