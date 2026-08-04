import {
  COLOR_COUNT,
  PIECE_KINDS,
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
 * Colors come as two pairs [A, A, B, B] with A !== B: a piece alone can never
 * hold 3 of a color, but it can complete a match with a single field block.
 */
export function makePiece(kind: PieceKind, rng: Rng): Piece {
  const a = rng.int(COLOR_COUNT) as CellColor
  const b = ((a + 1 + rng.int(COLOR_COUNT - 1)) % COLOR_COUNT) as CellColor
  return { kind, rot: 0, colors: [a, a, b, b] }
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
  return {
    kind: piece.kind,
    rot: ((piece.rot + dir + 4) % 4) as Rotation,
    colors: piece.colors,
  }
}
