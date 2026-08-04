// Tribble — drawing theme: palette + the block primitive shared by the board,
// the next-piece preview and the opponent mini-board.

import { STONE_HEX, pieceOffsets, type CellColor, type Piece } from '../types'

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
  const body = hex.slice(1)
  const full =
    body.length === 3 ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}` : body
  const v = Number.parseInt(full, 16)
  if (!Number.isFinite(v)) return [128, 128, 128]
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

function mix(rgb: [number, number, number], tr: number, tg: number, tb: number, t: number): string {
  const r = Math.round(rgb[0] + (tr - rgb[0]) * t)
  const g = Math.round(rgb[1] + (tg - rgb[1]) * t)
  const b = Math.round(rgb[2] + (tb - rgb[2]) * t)
  return `rgb(${r},${g},${b})`
}

/** The three shades a block body is painted with. */
interface BlockShades {
  fill: string
  bevel: string
  rim: string
}

function makeShades(hex: string): BlockShades {
  const rgb = channels(hex)
  return {
    fill: mix(rgb, 12, 10, 22, 0.12),
    bevel: mix(rgb, 255, 255, 255, 0.42),
    rim: mix(rgb, 6, 5, 12, 0.62),
  }
}

const PALETTE_SHADES: BlockShades[] = []
for (let i = 0; i < 4; i++) {
  PALETTE_SHADES.push(makeShades(COLOR_HEX[i as CellColor]))
}

// Override colors (stone) are derived once and memoized, so a locked board
// still never builds a color string per cell.
const overrideShades = new Map<string, BlockShades>()

function shadesFor(hex: string): BlockShades {
  let s = overrideShades.get(hex)
  if (!s) {
    s = makeShades(hex)
    overrideShades.set(hex, s)
  }
  return s
}

// Warm the one override the game actually uses every frame.
shadesFor(STONE_HEX)

/**
 * A single block: rounded body, top bevel, thin darker rim. No shadowBlur —
 * this runs once per filled cell every frame. `override` (a hex color) repaints
 * the block in that color instead of its palette entry: that is how a
 * colour-locked board reads as stone.
 */
export function drawBlock(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  color: CellColor,
  alpha = 1,
  override?: string,
): void {
  if (size <= 0 || alpha <= 0) return
  const prevAlpha = ctx.globalAlpha
  if (alpha !== 1) ctx.globalAlpha = prevAlpha * alpha

  const shades = override === undefined ? PALETTE_SHADES[color] : shadesFor(override)

  const gap = size * (size >= 12 ? 0.06 : 0.04)
  const x = px + gap
  const y = py + gap
  const w = size - gap * 2
  const h = size - gap * 2
  const r = Math.min(w, h) * 0.22

  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fillStyle = shades.fill
  ctx.fill()

  if (w >= 5) {
    ctx.beginPath()
    ctx.roundRect(x + w * 0.13, y + h * 0.11, w * 0.74, h * 0.3, Math.max(0.5, r * 0.6))
    ctx.fillStyle = shades.bevel
    ctx.fill()

    const lw = Math.max(1, size * 0.055)
    ctx.lineWidth = lw
    ctx.strokeStyle = shades.rim
    ctx.beginPath()
    ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, Math.max(0.5, r - lw / 2))
    ctx.stroke()
  }

  ctx.globalAlpha = prevAlpha
}

// ---------------------------------------------------------------------------
// Armour plating
// ---------------------------------------------------------------------------

/** Plate rim per armour tier (index 0 = one break left, 1 = two or more). */
const ARMOR_RIM = ['rgba(214,226,250,0.72)', 'rgba(240,247,255,0.92)']
const ARMOR_SEAT = 'rgba(8,9,18,0.45)'
const ARMOR_BRACE = ['rgba(206,220,248,0.42)', 'rgba(232,242,255,0.62)']
const ARMOR_RIVET = 'rgba(248,251,255,0.9)'

/**
 * A riveted metal plate laid over an already-drawn block: an inset rim, a
 * brace (single diagonal at 1, a full cross at 2+) and corner rivets. It is all
 * outline, so the block colour underneath stays readable for matching.
 * Same cost profile as drawBlock: no shadowBlur, no allocation.
 */
export function drawArmor(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  armor: number,
  alpha = 1,
): void {
  if (armor <= 0 || size < 4 || alpha <= 0) return
  const prevAlpha = ctx.globalAlpha
  if (alpha !== 1) ctx.globalAlpha = prevAlpha * alpha

  const heavy = armor >= 2 ? 1 : 0
  const inset = size * (size >= 12 ? 0.06 : 0.04) + size * (heavy ? 0.1 : 0.14)
  const x = px + inset
  const y = py + inset
  const w = size - inset * 2
  const h = size - inset * 2
  const r = Math.min(w, h) * 0.2
  const lw = Math.max(1, size * (heavy ? 0.085 : 0.06))

  // Dark seat offset down-right, so the plate reads as sitting on the block.
  ctx.lineWidth = lw
  ctx.strokeStyle = ARMOR_SEAT
  ctx.beginPath()
  ctx.roundRect(x + lw / 2 + lw * 0.4, y + lw / 2 + lw * 0.4, w - lw, h - lw, r)
  ctx.stroke()

  ctx.strokeStyle = ARMOR_RIM[heavy]
  ctx.beginPath()
  ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, r)
  ctx.stroke()

  if (size >= 9) {
    ctx.lineWidth = Math.max(1, size * (heavy ? 0.065 : 0.05))
    ctx.strokeStyle = ARMOR_BRACE[heavy]
    ctx.beginPath()
    ctx.moveTo(x + w * 0.18, y + h * 0.18)
    ctx.lineTo(x + w * 0.82, y + h * 0.82)
    if (heavy) {
      ctx.moveTo(x + w * 0.82, y + h * 0.18)
      ctx.lineTo(x + w * 0.18, y + h * 0.82)
    }
    ctx.stroke()
  }

  if (size >= 13) {
    const rr = Math.max(0.6, size * (heavy ? 0.058 : 0.046))
    const ix = w * 0.18
    const iy = h * 0.18
    ctx.fillStyle = ARMOR_RIVET
    ctx.beginPath()
    ctx.moveTo(x + ix + rr, y + iy)
    ctx.arc(x + ix, y + iy, rr, 0, Math.PI * 2)
    ctx.moveTo(x + w - ix + rr, y + iy)
    ctx.arc(x + w - ix, y + iy, rr, 0, Math.PI * 2)
    ctx.moveTo(x + ix + rr, y + h - iy)
    ctx.arc(x + ix, y + h - iy, rr, 0, Math.PI * 2)
    ctx.moveTo(x + w - ix + rr, y + h - iy)
    ctx.arc(x + w - ix, y + h - iy, rr, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.globalAlpha = prevAlpha
}

/**
 * Next-piece preview: clears its square, then centers the current rotation in
 * it. `override` repaints every block in that color (stone, while colours are
 * locked); an armoured piece is previewed plated.
 */
export function drawPieceThumb(
  ctx: CanvasRenderingContext2D,
  piece: Piece,
  sizePx: number,
  override?: string,
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

  const armor = piece.armor ?? 0
  for (let i = 0; i < offs.length; i++) {
    const o = offs[i]
    const px = left + o.x * cell
    const py = top + o.y * cell
    drawBlock(ctx, px, py, cell, piece.colors[i], 1, override)
    if (armor > 0) drawArmor(ctx, px, py, cell, armor)
  }
}
