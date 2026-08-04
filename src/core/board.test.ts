import { describe, expect, it } from 'vitest'
import {
  applyGravity,
  cloneGrid,
  collides,
  emptyGrid,
  findLines,
  findMatches,
  flatToGrid,
  gridToFlat,
  insertGarbageRow,
  scrambleColors,
  stackTopRow,
} from './board'
import { createRng } from './rng'
import { COLOR_COUNT, COLS, MATCH_MIN, ROWS, type CellColor, type Grid } from '../types'

/** Builds a grid from `.`/digit rows anchored to the BOTTOM of the board. */
function gridFrom(rows: string[]): Grid {
  const grid = emptyGrid()
  const offset = ROWS - rows.length
  for (let i = 0; i < rows.length; i++) {
    for (let c = 0; c < COLS; c++) {
      const ch = rows[i][c]
      if (ch !== undefined && ch !== '.') grid[offset + i][c] = Number(ch) as CellColor
    }
  }
  return grid
}

function fullRow(color: CellColor): string {
  return String(color).repeat(COLS)
}

function countFilled(grid: Grid): number {
  let n = 0
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] !== null) n++
  return n
}

describe('emptyGrid / cloneGrid', () => {
  it('is ROWS x COLS of nulls', () => {
    const grid = emptyGrid()
    expect(grid).toHaveLength(ROWS)
    for (const row of grid) {
      expect(row).toHaveLength(COLS)
      expect(row.every((c) => c === null)).toBe(true)
    }
  })

  it('rows are independent arrays', () => {
    const grid = emptyGrid()
    grid[0][0] = 1
    expect(grid[1][0]).toBeNull()
  })

  it('cloneGrid copies deeply', () => {
    const grid = gridFrom(['0.1........'])
    const copy = cloneGrid(grid)
    expect(copy).toEqual(grid)
    copy[ROWS - 1][0] = 3
    copy[0][5] = 2
    expect(grid[ROWS - 1][0]).toBe(0)
    expect(grid[0][5]).toBeNull()
  })
})

describe('collides', () => {
  const grid = gridFrom(['0..........'])

  it('is false in free space', () => {
    expect(collides(grid, [{ row: 10, col: 5, color: 0 }])).toBe(false)
  })

  it('detects the floor', () => {
    expect(collides(grid, [{ row: ROWS, col: 5, color: 0 }])).toBe(true)
    expect(collides(grid, [{ row: ROWS + 3, col: 5, color: 0 }])).toBe(true)
  })

  it('detects both side walls', () => {
    expect(collides(grid, [{ row: 10, col: -1, color: 0 }])).toBe(true)
    expect(collides(grid, [{ row: 10, col: COLS, color: 0 }])).toBe(true)
  })

  it('detects occupied cells', () => {
    expect(collides(grid, [{ row: ROWS - 1, col: 0, color: 1 }])).toBe(true)
    expect(collides(grid, [{ row: ROWS - 1, col: 1, color: 1 }])).toBe(false)
  })

  it('treats rows above the board as out of play, not collisions', () => {
    expect(collides(grid, [{ row: -1, col: 5, color: 0 }])).toBe(false)
    expect(collides(grid, [{ row: -4, col: 0, color: 0 }])).toBe(false)
  })

  it('still rejects out-of-play cells outside the side walls', () => {
    expect(collides(grid, [{ row: -1, col: -1, color: 0 }])).toBe(true)
    expect(collides(grid, [{ row: -1, col: COLS, color: 0 }])).toBe(true)
  })

  it('does not treat the launcher zone as a collision', () => {
    expect(collides(grid, [{ row: 0, col: 5, color: 0 }])).toBe(false)
    expect(collides(grid, [{ row: 2, col: 5, color: 0 }])).toBe(false)
  })

  it('collides when ANY cell of the group collides', () => {
    const cells = [
      { row: 10, col: 4, color: 0 as CellColor },
      { row: 10, col: 5, color: 0 as CellColor },
      { row: ROWS - 1, col: 0, color: 0 as CellColor },
    ]
    expect(collides(grid, cells)).toBe(true)
  })

  it('is false for an empty cell list', () => {
    expect(collides(grid, [])).toBe(false)
  })
})

describe('findLines', () => {
  it('finds nothing on an empty board', () => {
    expect(findLines(emptyGrid())).toEqual([])
  })

  it('ignores an almost-full row', () => {
    const grid = gridFrom([fullRow(1).slice(0, COLS - 1) + '.'])
    expect(findLines(grid)).toEqual([])
  })

  it('reports full rows top-down, whatever the colors', () => {
    const grid = gridFrom([fullRow(0), '0.1........', '0123012301.'.slice(0, COLS)])
    grid[ROWS - 1] = grid[ROWS - 1].map((_, c) => (c % 4) as CellColor)
    expect(findLines(grid)).toEqual([ROWS - 3, ROWS - 1])
  })
})

describe('findMatches', () => {
  it('finds nothing on an empty board', () => {
    expect(findMatches(emptyGrid())).toEqual([])
  })

  it('does NOT match a group of exactly 2', () => {
    expect(findMatches(gridFrom(['00.........']))).toEqual([])
    expect(findMatches(gridFrom(['0..........', '0..........']))).toEqual([])
  })

  it('matches a horizontal run of MATCH_MIN', () => {
    const matches = findMatches(gridFrom(['000........']))
    expect(matches).toHaveLength(1)
    expect(matches[0].color).toBe(0)
    expect(matches[0].cells).toHaveLength(MATCH_MIN)
  })

  it('matches an L shape', () => {
    const matches = findMatches(gridFrom(['2..........', '2..........', '22.........']))
    expect(matches).toHaveLength(1)
    expect(matches[0].color).toBe(2)
    expect(matches[0].cells).toHaveLength(4)
  })

  it('matches a plus shape as one group', () => {
    const matches = findMatches(gridFrom(['...1.......', '..111......', '...1.......']))
    expect(matches).toHaveLength(1)
    expect(matches[0].cells).toHaveLength(5)
    const keys = matches[0].cells.map((c) => `${c.row},${c.col}`)
    expect(new Set(keys).size).toBe(5)
  })

  it('keeps two separate same-color groups apart', () => {
    const matches = findMatches(gridFrom(['000.....000']))
    expect(matches).toHaveLength(2)
    for (const m of matches) {
      expect(m.color).toBe(0)
      expect(m.cells).toHaveLength(3)
    }
  })

  it('does not merge across colors and puts each cell in at most one group', () => {
    const matches = findMatches(gridFrom(['000111.2222']))
    expect(matches).toHaveLength(3)
    expect(matches.map((m) => m.color).sort()).toEqual([0, 1, 2])

    const seen = new Set<string>()
    for (const m of matches) {
      for (const cell of m.cells) {
        const key = `${cell.row},${cell.col}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
  })

  it('does not connect diagonally', () => {
    expect(findMatches(gridFrom(['0..........', '.0.........', '..0........']))).toEqual([])
  })

  it('reports cells that all carry the group color', () => {
    const grid = gridFrom(['3333.......', '3..........'])
    const matches = findMatches(grid)
    expect(matches).toHaveLength(1)
    for (const cell of matches[0].cells) expect(grid[cell.row][cell.col]).toBe(matches[0].color)
    expect(matches[0].cells).toHaveLength(5)
  })

  it('is stable when called repeatedly (shared scratch buffers)', () => {
    const grid = gridFrom(['000.....111'])
    const first = findMatches(grid)
    expect(findMatches(grid)).toEqual(first)
    expect(findMatches(emptyGrid())).toEqual([])
    expect(findMatches(grid)).toEqual(first)
  })
})

describe('applyGravity', () => {
  it('returns false and changes nothing on an empty board', () => {
    const grid = emptyGrid()
    expect(applyGravity(grid)).toBe(false)
    expect(grid).toEqual(emptyGrid())
  })

  it('returns false for an already resting stack', () => {
    const grid = gridFrom(['0.2........', '0123012301.'])
    const before = cloneGrid(grid)
    expect(applyGravity(grid)).toBe(false)
    expect(grid).toEqual(before)
  })

  it('drops a floating block to the floor', () => {
    const grid = emptyGrid()
    grid[4][2] = 1
    expect(applyGravity(grid)).toBe(true)
    expect(grid[4][2]).toBeNull()
    expect(grid[ROWS - 1][2]).toBe(1)
  })

  it('compacts each column independently and preserves order', () => {
    const grid = emptyGrid()
    grid[2][0] = 0
    grid[9][0] = 1
    grid[17][0] = 2
    grid[5][7] = 3
    expect(applyGravity(grid)).toBe(true)
    expect(grid[ROWS - 3][0]).toBe(0)
    expect(grid[ROWS - 2][0]).toBe(1)
    expect(grid[ROWS - 1][0]).toBe(2)
    expect(grid[ROWS - 1][7]).toBe(3)
    expect(countFilled(grid)).toBe(4)
  })

  it('fills holes left by a clear', () => {
    const grid = gridFrom(['111........', '...........', '222........'])
    grid[ROWS - 2][0] = null
    expect(applyGravity(grid)).toBe(true)
    expect(grid[ROWS - 1][0]).toBe(2)
    expect(grid[ROWS - 2][0]).toBe(1)
    expect(grid[ROWS - 3][0]).toBeNull()
  })

  it('is idempotent', () => {
    const grid = emptyGrid()
    grid[1][3] = 2
    grid[8][3] = 0
    applyGravity(grid)
    expect(applyGravity(grid)).toBe(false)
  })
})

describe('insertGarbageRow', () => {
  it('shifts every row up by one and drops the old row 0', () => {
    const grid = emptyGrid()
    grid[0][4] = 1
    grid[7][2] = 3
    grid[ROWS - 1][9] = 0
    insertGarbageRow(grid, createRng(1))

    expect(grid[6][2]).toBe(3)
    expect(grid[7][2]).toBeNull()
    expect(grid[ROWS - 2][9]).toBe(0)
    // the old row 0 fell off the top: nothing above row 6 survives
    for (let c = 0; c < COLS; c++) expect(grid[0][c]).toBeNull()
  })

  it('writes a bottom row with 2 or 3 holes and valid colors', () => {
    for (let seed = 0; seed < 60; seed++) {
      const grid = emptyGrid()
      insertGarbageRow(grid, createRng(seed))
      const bottom = grid[ROWS - 1]
      let holes = 0
      for (let c = 0; c < COLS; c++) {
        const cell = bottom[c]
        if (cell === null) {
          holes++
        } else {
          expect(cell).toBeGreaterThanOrEqual(0)
          expect(cell).toBeLessThan(COLOR_COUNT)
        }
      }
      expect(holes).toBeGreaterThanOrEqual(2)
      expect(holes).toBeLessThanOrEqual(3)
    }
  })

  it('keeps the grid dimensions and is deterministic per seed', () => {
    const a = emptyGrid()
    const b = emptyGrid()
    insertGarbageRow(a, createRng(31))
    insertGarbageRow(b, createRng(31))
    expect(a).toEqual(b)
    expect(a).toHaveLength(ROWS)
    expect(a[ROWS - 1]).toHaveLength(COLS)
  })

  it('stacks repeated insertions upward', () => {
    const grid = emptyGrid()
    const rng = createRng(5)
    for (let i = 0; i < 4; i++) insertGarbageRow(grid, rng)
    expect(stackTopRow(grid)).toBe(ROWS - 4)
    for (let r = 0; r < ROWS - 4; r++) {
      for (let c = 0; c < COLS; c++) expect(grid[r][c]).toBeNull()
    }
  })
})

describe('scrambleColors', () => {
  it('keeps the occupancy pattern and stays in palette', () => {
    const grid = gridFrom(['0000000....', '1111111111.', '2222222222.'])
    const before = cloneGrid(grid)
    scrambleColors(grid, createRng(4), 12)
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        expect(grid[r][c] === null).toBe(before[r][c] === null)
        const cell = grid[r][c]
        if (cell !== null) {
          expect(cell).toBeGreaterThanOrEqual(0)
          expect(cell).toBeLessThan(COLOR_COUNT)
        }
      }
    }
  })

  it('actually changes some colors', () => {
    const grid = gridFrom(['0000000000.', '0000000000.', '0000000000.'])
    const before = cloneGrid(grid)
    scrambleColors(grid, createRng(17), 20)
    let changed = 0
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) if (grid[r][c] !== before[r][c]) changed++
    }
    expect(changed).toBeGreaterThan(0)
  })

  it('handles count <= 0 and boards with fewer cells than count', () => {
    const grid = gridFrom(['01.........'])
    const before = cloneGrid(grid)
    scrambleColors(grid, createRng(2), 0)
    expect(grid).toEqual(before)
    scrambleColors(grid, createRng(2), 999)
    expect(countFilled(grid)).toBe(2)
    scrambleColors(emptyGrid(), createRng(2), 5)
  })
})

describe('stackTopRow', () => {
  it('returns ROWS when empty', () => {
    expect(stackTopRow(emptyGrid())).toBe(ROWS)
  })

  it('returns the highest occupied row', () => {
    const grid = emptyGrid()
    grid[7][10] = 2
    grid[15][0] = 1
    expect(stackTopRow(grid)).toBe(7)
    grid[0][5] = 0
    expect(stackTopRow(grid)).toBe(0)
  })

  it('matches a bottom-anchored stack height', () => {
    expect(stackTopRow(gridFrom(['0..........', '.1.........']))).toBe(ROWS - 2)
  })
})

describe('gridToFlat / flatToGrid', () => {
  it('encodes row-major with -1 for empty', () => {
    const grid = emptyGrid()
    grid[0][0] = 3
    grid[1][2] = 0
    const flat = gridToFlat(grid)
    expect(flat).toHaveLength(ROWS * COLS)
    expect(flat[0]).toBe(3)
    expect(flat[1]).toBe(-1)
    expect(flat[COLS + 2]).toBe(0)
  })

  it('round-trips an arbitrary board', () => {
    const rng = createRng(555)
    const grid = emptyGrid()
    for (let i = 0; i < 6; i++) insertGarbageRow(grid, rng)
    scrambleColors(grid, rng, 20)
    expect(flatToGrid(gridToFlat(grid))).toEqual(grid)
    expect(gridToFlat(flatToGrid(gridToFlat(grid)))).toEqual(gridToFlat(grid))
  })

  it('round-trips the empty board', () => {
    expect(flatToGrid(gridToFlat(emptyGrid()))).toEqual(emptyGrid())
  })

  it('produces an independent grid', () => {
    const grid = gridFrom(['0..........'])
    const restored = flatToGrid(gridToFlat(grid))
    restored[ROWS - 1][0] = 3
    expect(grid[ROWS - 1][0]).toBe(0)
  })

  it('treats out-of-palette values as empty', () => {
    const flat = new Array<number>(ROWS * COLS).fill(-1)
    flat[0] = 99
    flat[1] = -5
    flat[2] = 2
    const grid = flatToGrid(flat)
    expect(grid[0][0]).toBeNull()
    expect(grid[0][1]).toBeNull()
    expect(grid[0][2]).toBe(2)
  })

  it('rejects a wrong-sized payload', () => {
    expect(() => flatToGrid([1, 2, 3])).toThrow()
    expect(() => flatToGrid(new Array<number>(ROWS * COLS + 1).fill(-1))).toThrow()
  })
})
