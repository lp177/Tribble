import { describe, expect, it } from 'vitest'
import { createRng } from './rng'
import { makeBag, makePiece, pieceCells, rotatePiece } from './piece'
import { COLOR_COUNT, PIECE_KINDS, type Piece, type PieceKind } from '../types'

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

  it('four rotations return the original cell set, colors included', () => {
    for (const kind of PIECE_KINDS) {
      const piece: Piece = { kind, rot: 0, colors: [2, 2, 0, 0] }
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
