import { describe, expect, it } from 'vitest'
import {
  CLEARS_PER_LEVEL,
  COLS,
  CURSE_DURATION,
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
  type Game,
  type Grid,
  type Piece,
  type PlacedCell,
} from '../types'
import { cloneGrid, stackTopRow } from './board'
import { pieceCells } from './piece'
import { createRng } from './rng'
import { computeAimPath, createGame, loadGame } from './game'

const FRAME = 1 / 60

function clearGrid(grid: Grid): void {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) grid[r][c] = null
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

describe('flight, snap and lock', () => {
  it('locks pieces inside the board without ever overlapping (fuzz)', () => {
    const rng = createRng(0xc0ffee)
    let game = createGame({ seed: rng.int(1 << 30) })
    let before: Grid = cloneGrid(game.state.grid)
    let locks = 0
    let gameOvers = 0

    game.events.on('impact', () => {
      before = cloneGrid(game.state.grid)
    })
    const attach = (g: Game): void => {
      g.events.on('impact', () => {
        before = cloneGrid(g.state.grid)
      })
      g.events.on('lock', ({ cells }: { cells: PlacedCell[] }) => {
        locks++
        for (const cell of cells) {
          expect(cell.col).toBeGreaterThanOrEqual(0)
          expect(cell.col).toBeLessThan(COLS)
          expect(cell.row).toBeLessThan(ROWS)
          if (cell.row >= 0) expect(before[cell.row][cell.col]).toBeNull()
        }
      })
    }
    attach(game)

    for (let i = 0; i < 400; i++) {
      const angle = (rng.next() * 2 - 1) * MAX_AIM_ANGLE
      const frames = runLaunch(game, angle, 600)
      expect(frames).toBeLessThan(600)
      expect(['aiming', 'gameover']).toContain(game.state.phase)

      for (let r = 0; r < ROWS; r++) {
        expect(game.state.grid[r].length).toBe(COLS)
        for (let c = 0; c < COLS; c++) {
          const cell = game.state.grid[r][c]
          if (cell !== null) expect(cell).toBeGreaterThanOrEqual(0)
          if (cell !== null) expect(cell).toBeLessThan(4)
        }
      }

      if (game.state.phase === 'gameover') {
        gameOvers++
        game = createGame({ seed: rng.int(1 << 30) })
        attach(game)
      }
    }

    expect(locks).toBeGreaterThan(300)
    expect(gameOvers).toBeGreaterThan(0)
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
    expect(save.version).toBe(1)
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
