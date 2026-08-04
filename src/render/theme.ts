// Tribble — drawing theme: palette + the block primitive shared by the board,
// the next-piece preview and the opponent mini-board.

import { pieceOffsets, type CellColor, type Piece } from '../types'

/** Dark neon palette; tuned to pop on the near-black board. */
export const COLOR_HEX: Record<CellColor, string> = {
  0: '#ff5c8a',
  1: '#ffd166',
  2: '#06d6a0',
  3: '#4cc9f0',
}

export const POWER_COLOR = '#b388ff'
export const BG_COLOR = '#0f0f17'
export const UI_FONT =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

// ---------------------------------------------------------------------------
// Derived shades (computed once; drawBlock never builds a color string)
// ---------------------------------------------------------------------------

function channels(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

function mix(rgb: [number, number, number], tr: number, tg: number, tb: number, t: number): string {
  const r = Math.round(rgb[0] + (tr - rgb[0]) * t)
  const g = Math.round(rgb[1] + (tg - rgb[1]) * t)
  const b = Math.round(rgb[2] + (tb - rgb[2]) * t)
  return `rgb(${r},${g},${b})`
}

const FILL: string[] = []
const BEVEL: string[] = []
const RIM: string[] = []

for (let i = 0; i < 4; i++) {
  const rgb = channels(COLOR_HEX[i as CellColor])
  FILL.push(mix(rgb, 12, 10, 22, 0.12))
  BEVEL.push(mix(rgb, 255, 255, 255, 0.42))
  RIM.push(mix(rgb, 6, 5, 12, 0.62))
}

/**
 * A single block: rounded body, top bevel, thin darker rim. No shadowBlur —
 * this runs once per filled cell every frame.
 */
export function drawBlock(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  color: CellColor,
  alpha = 1,
): void {
  if (size <= 0 || alpha <= 0) return
  const prevAlpha = ctx.globalAlpha
  if (alpha !== 1) ctx.globalAlpha = prevAlpha * alpha

  const gap = size * (size >= 12 ? 0.06 : 0.04)
  const x = px + gap
  const y = py + gap
  const w = size - gap * 2
  const h = size - gap * 2
  const r = Math.min(w, h) * 0.22

  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fillStyle = FILL[color]
  ctx.fill()

  if (w >= 5) {
    ctx.beginPath()
    ctx.roundRect(x + w * 0.13, y + h * 0.11, w * 0.74, h * 0.3, Math.max(0.5, r * 0.6))
    ctx.fillStyle = BEVEL[color]
    ctx.fill()

    const lw = Math.max(1, size * 0.055)
    ctx.lineWidth = lw
    ctx.strokeStyle = RIM[color]
    ctx.beginPath()
    ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, Math.max(0.5, r - lw / 2))
    ctx.stroke()
  }

  ctx.globalAlpha = prevAlpha
}

/** Next-piece preview: clears its square, then centers the current rotation in it. */
export function drawPieceThumb(
  ctx: CanvasRenderingContext2D,
  piece: Piece,
  sizePx: number,
): void {
  ctx.clearRect(0, 0, sizePx, sizePx)
  if (sizePx <= 0) return

  const offs = pieceOffsets(piece)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < offs.length; i++) {
    const o = offs[i]
    if (o.x < minX) minX = o.x
    if (o.x > maxX) maxX = o.x
    if (o.y < minY) minY = o.y
    if (o.y > maxY) maxY = o.y
  }

  const cols = maxX - minX + 1
  const rows = maxY - minY + 1
  const pad = sizePx * 0.1
  const cell = Math.min((sizePx - pad * 2) / cols, (sizePx - pad * 2) / rows)
  const left = (sizePx - cols * cell) / 2 - minX * cell
  const top = (sizePx - rows * cell) / 2 - minY * cell

  for (let i = 0; i < offs.length; i++) {
    const o = offs[i]
    drawBlock(ctx, left + o.x * cell, top + o.y * cell, cell, piece.colors[i])
  }
}
