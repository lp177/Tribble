import { describe, expect, it } from 'vitest'
import { createRng } from './rng'
import { makeBag, makePiece, pieceCells, rotatePiece } from './piece'
import {
  BIG_PIECE_KINDS,
  COLOR_COUNT,
  MATCH_MIN,
  MAX_PIECE_CELLS,
  PIECE_KINDS,
  SHAPES,
  type CellColor,
  type Piece,
  type PieceKind,
  type PlacedCell,
} from '../types'

const ALL_KINDS: readonly PieceKind[] = [...PIECE_KINDS, ...BIG_PIECE_KINDS]

/** Size of the largest orthogonally connected same-colour group in a piece. */
function biggestGroup(cells: PlacedCell[]): number {
  const byKey = new Map<string, PlacedCell>()
  for (const cell of cells) byKey.set(`${cell.row},${cell.col}`, cell)

  let biggest = 0
  const seen = new Set<string>()
  for (const cell of cells) {
    const key = `${cell.row},${cell.col}`
    if (seen.has(key)) continue
    seen.add(key)
    const queue: PlacedCell[] = [cell]
    let size = 0
    while (queue.length > 0) {
      const cur = queue.pop() as PlacedCell
      size++
      const around = [
        `${cur.row - 1},${cur.col}`,
        `${cur.row + 1},${cur.col}`,
        `${cur.row},${cur.col - 1}`,
        `${cur.row},${cur.col + 1}`,
      ]
      for (const k of around) {
        const n = byKey.get(k)
        if (n === undefined || n.color !== cell.color || seen.has(k)) continue
        seen.add(k)
        queue.push(n)
      }
    }
    if (size > biggest) biggest = size
  }
  return biggest
}

describe('createRng', () => {
  it('produces floats in [0, 1)', () => {
    const rng = createRng(12345)
    for (let i = 0; i < 1000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('is deterministic for a given seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    const seqA = Array.from({ length: 50 }, () => a.next())
    const seqB = Array.from({ length: 50 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })

  it('gives different streams for different seeds', () => {
    const r1 = createRng(1)
    const r2 = createRng(2)
    const a = Array.from({ length: 20 }, () => r1.next())
    const b = Array.from({ length: 20 }, () => r2.next())
    expect(a).not.toEqual(b)
  })

  it('int(n) stays in [0, n) and covers the range', () => {
    const rng = createRng(7)
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(COLOR_COUNT)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(COLOR_COUNT)
      seen.add(v)
    }
    expect(seen.size).toBe(COLOR_COUNT)
  })

  it('int(0) does not produce garbage', () => {
    expect(createRng(3).int(0)).toBe(0)
  })

  it('pick returns members of the array', () => {
    const rng = createRng(9)
    const arr = ['a', 'b', 'c'] as const
    for (let i = 0; i < 100; i++) expect(arr).toContain(rng.pick(arr))
  })

  it('setState round-trips: identical future stream', () => {
    const rng = createRng(2024)
    for (let i = 0; i < 17; i++) rng.next()

    const saved = rng.getState()
    const expected = Array.from({ length: 30 }, () => rng.next())

    const resumed = createRng(0)
    resumed.setState(saved)
    const actual = Array.from({ length: 30 }, () => resumed.next())
    expect(actual).toEqual(expected)

    rng.setState(saved)
    expect(Array.from({ length: 30 }, () => rng.next())).toEqual(expected)
  })

  it('getState is a uint32', () => {
    const rng = createRng(-1)
    expect(rng.getState()).toBe(0xffffffff)
    rng.next()
    const s = rng.getState()
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(0xffffffff)
    expect(Number.isInteger(s)).toBe(true)
  })
})

describe('makeBag', () => {
  it('contains every kind exactly once', () => {
    for (let seed = 0; seed < 40; seed++) {
      const bag = makeBag(createRng(seed))
      expect(bag).toHaveLength(7)
      expect([...bag].sort()).toEqual([...PIECE_KINDS].sort())
    }
  })

  it('is seed-deterministic', () => {
    expect(makeBag(createRng(99))).toEqual(makeBag(createRng(99)))
  })

  it('does not always return the same order', () => {
    const orders = new Set<string>()
    for (let seed = 0; seed < 30; seed++) orders.add(makeBag(createRng(seed)).join(''))
    expect(orders.size).toBeGreaterThan(1)
  })

  it('does not mutate PIECE_KINDS', () => {
    const before = [...PIECE_KINDS]
    makeBag(createRng(5))
    expect([...PIECE_KINDS]).toEqual(before)
  })
})

describe('makePiece', () => {
  it('always pairs colors as [A, A, B, B] with A !== B', () => {
    const rng = createRng(1234)
    for (let i = 0; i < 500; i++) {
      const kind = PIECE_KINDS[i % PIECE_KINDS.length]
      const piece = makePiece(kind, rng)
      expect(piece.kind).toBe(kind)
      expect(piece.rot).toBe(0)
      expect(piece.colors[0]).toBe(piece.colors[1])
      expect(piece.colors[2]).toBe(piece.colors[3])
      expect(piece.colors[0]).not.toBe(piece.colors[2])
      for (const c of piece.colors) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThan(COLOR_COUNT)
      }
    }
  })

  it('is seed-deterministic', () => {
    expect(makePiece('T', createRng(8))).toEqual(makePiece('T', createRng(8)))
  })

  it('uses the whole palette across seeds', () => {
    const rng = createRng(77)
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const p = makePiece('O', rng)
      seen.add(p.colors[0])
      seen.add(p.colors[2])
    }
    expect(seen.size).toBe(COLOR_COUNT)
  })

  it('matches the shape length, pentominoes included', () => {
    const rng = createRng(2468)
    for (const kind of ALL_KINDS) {
      const piece = makePiece(kind, rng)
      const n = SHAPES[kind][0].length
      expect(piece.colors).toHaveLength(n)
      expect(n).toBeLessThanOrEqual(MAX_PIECE_CELLS)
      expect(pieceCells(piece, 5.5, 5.5)).toHaveLength(n)
    }
  })

  it('pairs the pentomino colors as [A, A, B, B, A]', () => {
    const rng = createRng(1357)
    for (let i = 0; i < 200; i++) {
      const kind = BIG_PIECE_KINDS[i % BIG_PIECE_KINDS.length]
      const c = makePiece(kind, rng).colors
      expect(c).toHaveLength(5)
      expect(c[0]).toBe(c[1])
      expect(c[2]).toBe(c[3])
      expect(c[4]).toBe(c[0])
      expect(c[0]).not.toBe(c[2])
    }
  })

  it('can never self-match, in any kind or rotation', () => {
    const rng = createRng(864)
    for (let i = 0; i < 240; i++) {
      const kind = ALL_KINDS[i % ALL_KINDS.length]
      let piece = makePiece(kind, rng)
      for (let r = 0; r < 4; r++) {
        expect(biggestGroup(pieceCells(piece, 5.5, 5.5))).toBeLessThan(MATCH_MIN)
        piece = rotatePiece(piece, 1)
      }
    }
  })
})

function makeTestPiece(kind: PieceKind): Piece {
  return { kind, rot: 0, colors: [0, 0, 1, 1] }
}

function cellKeys(piece: Piece, x: number, y: number): string[] {
  return pieceCells(piece, x, y)
    .map((c) => `${c.row},${c.col}`)
    .sort()
}

describe('pieceCells', () => {
  it('floors the continuous pivot per offset', () => {
    const piece = makeTestPiece('T')
    const cells = pieceCells(piece, 3.5, 5.5)
    expect(cells).toEqual([
      { row: 5, col: 2, color: 0 },
      { row: 5, col: 3, color: 0 },
      { row: 5, col: 4, color: 1 },
      { row: 6, col: 3, color: 1 },
    ])
  })

  it('binds colors[i] to cell i', () => {
    const piece: Piece = { kind: 'S', rot: 2, colors: [3, 3, 1, 1] }
    const cells = pieceCells(piece, 4.2, 9.9)
    for (let i = 0; i < 4; i++) expect(cells[i].color).toBe(piece.colors[i])
  })

  it('yields 4 distinct cells for every kind and rotation', () => {
    for (const kind of PIECE_KINDS) {
      let piece = makeTestPiece(kind)
      for (let r = 0; r < 4; r++) {
        const keys = cellKeys(piece, 5.5, 5.5)
        expect(new Set(keys).size).toBe(4)
        piece = rotatePiece(piece, 1)
      }
    }
  })

  it('yields 5 distinct cells for every pentomino and rotation', () => {
    for (const kind of BIG_PIECE_KINDS) {
      let piece: Piece = { kind, rot: 0, colors: [0, 0, 1, 1, 0] }
      for (let r = 0; r < 4; r++) {
        const keys = cellKeys(piece, 5.5, 5.5)
        expect(keys).toHaveLength(5)
        expect(new Set(keys).size).toBe(5)
        piece = rotatePiece(piece, 1)
      }
    }
  })

  it('translates rigidly with the pivot', () => {
    const piece = makeTestPiece('J')
    const base = pieceCells(piece, 4.5, 6.5)
    const moved = pieceCells(piece, 6.5, 8.5)
    for (let i = 0; i < 4; i++) {
      expect(moved[i].col - base[i].col).toBe(2)
      expect(moved[i].row - base[i].row).toBe(2)
    }
  })
})

describe('rotatePiece', () => {
  it('cycles rot forwards and backwards', () => {
    let piece = makeTestPiece('L')
    expect(rotatePiece(piece, 1).rot).toBe(1)
    expect(rotatePiece(piece, -1).rot).toBe(3)
    piece = { ...piece, rot: 3 }
    expect(rotatePiece(piece, 1).rot).toBe(0)
  })

  it('returns a new piece and never mutates the source', () => {
    const piece = makeTestPiece('Z')
    const rotated = rotatePiece(piece, 1)
    expect(rotated).not.toBe(piece)
    expect(piece.rot).toBe(0)
    expect(rotated.kind).toBe(piece.kind)
    expect(rotated.colors).toEqual(piece.colors)
  })

  it('carries the piece armour through a rotation', () => {
    const piece: Piece = { kind: 'T', rot: 0, colors: [1, 1, 3, 3], armor: 2 }
    expect(rotatePiece(piece, 1).armor).toBe(2)
    expect(rotatePiece(piece, -1).armor).toBe(2)
    expect(rotatePiece(makeTestPiece('T'), 1).armor).toBeUndefined()
  })

  it('four rotations return the original cell set, colors included', () => {
    for (const kind of ALL_KINDS) {
      const colors: CellColor[] = SHAPES[kind][0].length === 5 ? [2, 2, 0, 0, 2] : [2, 2, 0, 0]
      const piece: Piece = { kind, rot: 0, colors }
      let rotated = piece
      for (let i = 0; i < 4; i++) rotated = rotatePiece(rotated, 1)
      expect(rotated.rot).toBe(piece.rot)
      expect(pieceCells(rotated, 5.5, 5.5)).toEqual(pieceCells(piece, 5.5, 5.5))

      let back = piece
      for (let i = 0; i < 4; i++) back = rotatePiece(back, -1)
      expect(pieceCells(back, 5.5, 5.5)).toEqual(pieceCells(piece, 5.5, 5.5))
    }
  })

  it('keeps colors attached to their cell index through rotation', () => {
    const piece: Piece = { kind: 'T', rot: 0, colors: [1, 1, 3, 3] }
    let rotated = piece
    for (let r = 1; r < 4; r++) {
      rotated = rotatePiece(rotated, 1)
      const cells = pieceCells(rotated, 5.5, 5.5)
      for (let i = 0; i < 4; i++) expect(cells[i].color).toBe(piece.colors[i])
    }
  })

  it('keeps the paired cells orthogonally adjacent so a piece cannot self-match', () => {
    for (const kind of PIECE_KINDS) {
      let piece: Piece = { kind, rot: 0, colors: [0, 0, 1, 1] }
      for (let r = 0; r < 4; r++) {
        const cells = pieceCells(piece, 5.5, 5.5)
        const sameColorTriples = cells.filter((c) => c.color === 0)
        expect(sameColorTriples).toHaveLength(2)
        piece = rotatePiece(piece, 1)
      }
    }
  })
})
