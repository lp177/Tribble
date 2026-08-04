import {
  COLOR_COUNT,
  COLS,
  MATCH_MIN,
  ROWS,
  type Cell,
  type CellColor,
  type Grid,
  type Match,
  type PlacedCell,
  type Rng,
} from '../types'

export function emptyGrid(): Grid {
  const grid: Grid = []
  for (let r = 0; r < ROWS; r++) {
    const row: Cell[] = new Array<Cell>(COLS)
    for (let c = 0; c < COLS; c++) row[c] = null
    grid.push(row)
  }
  return grid
}

export function cloneGrid(grid: Grid): Grid {
  const out: Grid = []
  for (let r = 0; r < ROWS; r++) out.push(grid[r].slice())
  return out
}

/** Armour layer parallel to a grid; 0 = a normal block (or an empty cell). */
export function emptyArmor(): number[][] {
  const armor: number[][] = []
  for (let r = 0; r < ROWS; r++) {
    const row = new Array<number>(COLS)
    for (let c = 0; c < COLS; c++) row[c] = 0
    armor.push(row)
  }
  return armor
}

export function cloneArmor(armor: number[][]): number[][] {
  const out: number[][] = []
  for (let r = 0; r < ROWS; r++) out.push(armor[r].slice())
  return out
}

/**
 * Side walls, floor and occupied cells collide. Rows above the board (row < 0)
 * are simply out of play, and the launcher-zone rows are ordinary free space.
 */
export function collides(grid: Grid, cells: PlacedCell[]): boolean {
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    if (cell.col < 0 || cell.col >= COLS || cell.row >= ROWS) return true
    if (cell.row < 0) continue
    if (grid[cell.row][cell.col] !== null) return true
  }
  return false
}

export function findLines(grid: Grid): number[] {
  const lines: number[] = []
  for (let r = 0; r < ROWS; r++) {
    const row = grid[r]
    let full = true
    for (let c = 0; c < COLS; c++) {
      if (row[c] === null) {
        full = false
        break
      }
    }
    if (full) lines.push(r)
  }
  return lines
}

const visited = new Uint8Array(ROWS * COLS)
const stack = new Int32Array(ROWS * COLS)

/** Orthogonally connected same-color groups of MATCH_MIN+ cells, disjoint. */
export function findMatches(grid: Grid): Match[] {
  visited.fill(0)
  const matches: Match[] = []

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const color = grid[r][c]
      if (color === null || visited[r * COLS + c] !== 0) continue

      let top = 0
      stack[top++] = r * COLS + c
      visited[r * COLS + c] = 1
      const cells: Array<{ row: number; col: number }> = []

      while (top > 0) {
        const idx = stack[--top]
        const cr = (idx / COLS) | 0
        const cc = idx - cr * COLS
        cells.push({ row: cr, col: cc })

        if (cr > 0) top = pushNeighbor(grid, cr - 1, cc, color, top)
        if (cr < ROWS - 1) top = pushNeighbor(grid, cr + 1, cc, color, top)
        if (cc > 0) top = pushNeighbor(grid, cr, cc - 1, color, top)
        if (cc < COLS - 1) top = pushNeighbor(grid, cr, cc + 1, color, top)
      }

      if (cells.length >= MATCH_MIN) matches.push({ color, cells })
    }
  }
  return matches
}

/** Marks and stacks (r, c) if it continues the group; returns the new stack top. */
function pushNeighbor(grid: Grid, r: number, c: number, color: CellColor, top: number): number {
  const idx = r * COLS + c
  if (visited[idx] !== 0 || grid[r][c] !== color) return top
  visited[idx] = 1
  stack[top] = idx
  return top + 1
}

/**
 * Puyo-style per-cell gravity: every block drops to the lowest free cell.
 * When an armour layer is passed it travels with the blocks, cell for cell.
 */
export function applyGravity(grid: Grid, armor?: number[][]): boolean {
  let moved = false
  for (let c = 0; c < COLS; c++) {
    let write = ROWS - 1
    for (let r = ROWS - 1; r >= 0; r--) {
      const cell = grid[r][c]
      if (cell === null) continue
      if (r !== write) {
        grid[write][c] = cell
        grid[r][c] = null
        if (armor !== undefined) {
          armor[write][c] = armor[r][c]
          armor[r][c] = 0
        }
        moved = true
      }
      write--
    }
  }
  return moved
}

/**
 * Shifts everything up one row (row 0 falls off) and adds a garbage bottom row.
 * The armour layer shifts with it; the fresh bottom row is never armoured.
 */
export function insertGarbageRow(grid: Grid, rng: Rng, armor?: number[][]): void {
  for (let r = 0; r < ROWS - 1; r++) {
    const dst = grid[r]
    const src = grid[r + 1]
    for (let c = 0; c < COLS; c++) dst[c] = src[c]
    if (armor !== undefined) {
      const adst = armor[r]
      const asrc = armor[r + 1]
      for (let c = 0; c < COLS; c++) adst[c] = asrc[c]
    }
  }

  const bottom = grid[ROWS - 1]
  for (let c = 0; c < COLS; c++) bottom[c] = rng.int(COLOR_COUNT) as CellColor
  if (armor !== undefined) {
    const abottom = armor[ROWS - 1]
    for (let c = 0; c < COLS; c++) abottom[c] = 0
  }

  const holes = 2 + rng.int(2)
  let placed = 0
  let guard = 0
  while (placed < holes && guard < 100) {
    guard++
    const c = rng.int(COLS)
    if (bottom[c] === null) continue
    bottom[c] = null
    placed++
  }
}

/** Re-rolls the color of up to `count` randomly chosen occupied cells. */
export function scrambleColors(grid: Grid, rng: Rng, count: number): void {
  if (count <= 0) return
  const occupied: number[] = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c] !== null) occupied.push(r * COLS + c)
    }
  }

  const n = Math.min(count, occupied.length)
  for (let i = 0; i < n; i++) {
    const j = i + rng.int(occupied.length - i)
    const idx = occupied[j]
    occupied[j] = occupied[i]
    occupied[i] = idx
    const r = (idx / COLS) | 0
    grid[r][idx - r * COLS] = rng.int(COLOR_COUNT) as CellColor
  }
}

/** Index of the highest row holding a block, or ROWS when the board is empty. */
export function stackTopRow(grid: Grid): number {
  for (let r = 0; r < ROWS; r++) {
    const row = grid[r]
    for (let c = 0; c < COLS; c++) {
      if (row[c] !== null) return r
    }
  }
  return ROWS
}

/** Row-major flat encoding for saves and network snapshots; -1 = empty. */
export function gridToFlat(grid: Grid): number[] {
  const flat: number[] = new Array<number>(ROWS * COLS)
  for (let r = 0; r < ROWS; r++) {
    const row = grid[r]
    for (let c = 0; c < COLS; c++) {
      const cell = row[c]
      flat[r * COLS + c] = cell === null ? -1 : cell
    }
  }
  return flat
}

export function flatToGrid(flat: readonly number[]): Grid {
  if (flat.length !== ROWS * COLS) {
    throw new Error(`flatToGrid: expected ${ROWS * COLS} cells, got ${flat.length}`)
  }
  const grid = emptyGrid()
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i]
    if (v < 0 || v >= COLOR_COUNT) continue
    const r = (i / COLS) | 0
    grid[r][i - r * COLS] = v as CellColor
  }
  return grid
}

/** Same row-major encoding for the armour layer; negatives clamp to 0. */
export function armorToFlat(armor: number[][]): number[] {
  const flat: number[] = new Array<number>(ROWS * COLS)
  for (let r = 0; r < ROWS; r++) {
    const row = armor[r]
    for (let c = 0; c < COLS; c++) flat[r * COLS + c] = row[c] > 0 ? row[c] : 0
  }
  return flat
}

export function flatToArmor(flat: readonly number[]): number[][] {
  if (flat.length !== ROWS * COLS) {
    throw new Error(`flatToArmor: expected ${ROWS * COLS} cells, got ${flat.length}`)
  }
  const armor = emptyArmor()
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i]
    if (!(v > 0)) continue
    const r = (i / COLS) | 0
    armor[r][i - r * COLS] = Math.floor(v)
  }
  return armor
}
