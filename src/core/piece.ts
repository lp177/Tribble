import {
  COLOR_COUNT,
  PIECE_KINDS,
  SHAPES,
  pieceOffsets,
  type CellColor,
  type Piece,
  type PieceKind,
  type PlacedCell,
  type Rng,
  type Rotation,
} from '../types'

/** 7-bag: a shuffled copy of every kind, so droughts stay bounded. */
export function makeBag(rng: Rng): PieceKind[] {
  const bag = PIECE_KINDS.slice()
  for (let i = bag.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const tmp = bag[i]
    bag[i] = bag[j]
    bag[j] = tmp
  }
  return bag
}

/**
 * Colors come as adjacent pairs — [A, A, B, B], and [A, A, B, B, A] for the
 * 5-cell pentominoes — with A !== B: a piece alone can never hold 3 connected
 * cells of a color, but it can complete a match with a single field block.
 */
export function makePiece(kind: PieceKind, rng: Rng): Piece {
  const a = rng.int(COLOR_COUNT) as CellColor
  const b = ((a + 1 + rng.int(COLOR_COUNT - 1)) % COLOR_COUNT) as CellColor
  const n = SHAPES[kind][0].length
  const colors: CellColor[] = new Array<CellColor>(n)
  // Pair up cells 0/1 and 2/3; a fifth cell rejoins A, which the shape data
  // keeps away from the A pair so the group never reaches MATCH_MIN.
  for (let i = 0; i < n; i++) colors[i] = i === 2 || i === 3 ? b : a
  return { kind, rot: 0, colors }
}

/** Grid cells for a pivot at continuous (x, y); cell i keeps colors[i]. */
export function pieceCells(piece: Piece, x: number, y: number): PlacedCell[] {
  const offsets = pieceOffsets(piece)
  const cells: PlacedCell[] = []
  for (let i = 0; i < offsets.length; i++) {
    const off = offsets[i]
    cells.push({
      row: Math.floor(y + off.y),
      col: Math.floor(x + off.x),
      color: piece.colors[i],
    })
  }
  return cells
}

export function rotatePiece(piece: Piece, dir: 1 | -1): Piece {
  const rotated: Piece = {
    kind: piece.kind,
    rot: ((piece.rot + dir + 4) % 4) as Rotation,
    colors: piece.colors,
  }
  if (piece.armor !== undefined) rotated.armor = piece.armor
  return rotated
}
