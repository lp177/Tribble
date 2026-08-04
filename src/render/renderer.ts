// Tribble — canvas renderer. Everything is drawn in CSS pixels; the backing
// store is scaled by the device pixel ratio once, in resize().

import {
  COLS,
  HAZARD_DURATION,
  HAZARD_LABEL,
  LAUNCH_X,
  LAUNCH_Y,
  ROWS,
  STONE_HEX,
  TOP_KILL_ROW,
  pieceOffsets,
  type ActiveHazard,
  type AimPoint,
  type BoardMetrics,
  type CurseKind,
  type FlyingPiece,
  type GameState,
  type Grid,
  type HazardKind,
  type OpponentView,
  type Piece,
  type PowerBubble,
  type RenderOptions,
  type Renderer,
  type RendererDeps,
} from '../types'
import { BG_COLOR, POWER_COLOR, UI_FONT, drawArmor, drawBlock } from './theme'

const TAU = Math.PI * 2

/** Fraction of the board width reserved for the opponent sidebar (+ gap). */
const SIDE_FRAC = 0.35
const GAP_FRAC = 0.07

const KILL_DASH: number[] = [9, 7]
const WAIT_DASH: number[] = [6, 6]
const NO_DASH: number[] = []

const CURSE_GLYPH: Record<CurseKind, string> = {
  garbage: '🧱',
  speed: '⚡',
  fog: '🌫️',
  scramble: '🎲',
  mirror: '🪞',
  lockRotate: '🔒',
}

// -- Hazard banner -----------------------------------------------------------

const HAZARD_ACCENT: Record<HazardKind, string> = {
  stone: '#9aa3b6',
  armor: '#9ab4e6',
  giant: '#ffab5e',
  rush: '#ff5c8a',
}

/** Never eat more of the play area than this, however many hazards overlap. */
const MAX_HAZARD_BANNERS = 3
const HAZARD_FADE_IN = 0.3
const HAZARD_FADE_OUT = 0.6
/**
 * The banner is an intro callout, not a status readout: it sits in the lane
 * pieces fly through, and the HUD already carries the label and countdown for
 * the whole hazard. So announce, then get out of the way.
 */
const HAZARD_BANNER_HOLD = 2.6

// -- Static star field (normalized coords, three parallax layers) ------------

const STAR_COUNT = 96
const STAR_LAYERS = 3
const starX = new Float32Array(STAR_COUNT)
const starY = new Float32Array(STAR_COUNT)
const starR = new Float32Array(STAR_COUNT)
const starLayer = new Uint8Array(STAR_COUNT)
const STAR_TINT = [
  'rgba(140,150,210,0.30)',
  'rgba(180,192,255,0.42)',
  'rgba(226,234,255,0.60)',
]
const STAR_DRIFT = [0.006, 0.012, 0.022]

{
  let s = 0x9e3779b9 >>> 0
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  for (let i = 0; i < STAR_COUNT; i++) {
    starX[i] = rnd()
    starY[i] = rnd()
    const layer = i % STAR_LAYERS
    starLayer[i] = layer
    starR[i] = 0.5 + layer * 0.35 + rnd() * 0.5
  }
}

export function createRenderer(deps: RendererDeps): Renderer {
  const { canvas, juice, particles } = deps
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) throw new Error('Tribble: 2D canvas context unavailable')
  const ctx: CanvasRenderingContext2D = ctx2d

  let dpr = 1
  let cssW = 0
  let cssH = 0
  /** True for the whole of a versus match: the sidebar is reserved up front. */
  let hasOpponent = false

  const metrics: BoardMetrics = { originX: 0, originY: 0, cellSize: 0, width: 0, height: 0 }
  let sideX = 0
  let sideY = 0
  let sideW = 0
  let sideH = 0
  // Mini-board geometry inside the sidebar, baked with the layout so the live
  // opponent view and its waiting placeholder occupy exactly the same box.
  let sideHeaderH = 0
  let sideCell = 0
  let sideGx = 0
  let sideGy = 0
  let sideGw = 0
  let sideGh = 0
  let sidePad = 0

  // The two vignettes are baked once per layout: re-evaluating a large radial
  // gradient every frame is by far the most expensive thing this renderer does.
  let vignetteLayer: OffscreenCanvas | null = null
  let dangerLayer: OffscreenCanvas | null = null
  let dangerLayerW = 0
  let dangerLayerH = 0
  let fogGrad: CanvasGradient | null = null

  let fontGlyph = ''
  let fontName = ''
  let fontScore = ''
  let fontKo = ''
  let fontHazard = ''

  let nameSource = ''
  let nameShown = ''

  const t0 = performance.now()

  // -- Layout ---------------------------------------------------------------

  function makeLayer(
    cssWidth: number,
    cssHeight: number,
  ): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null {
    if (typeof OffscreenCanvas === 'undefined') return null
    const w = Math.max(1, Math.round(cssWidth * dpr))
    const h = Math.max(1, Math.round(cssHeight * dpr))
    const layer = new OffscreenCanvas(w, h)
    const lctx = layer.getContext('2d')
    if (!lctx) return null
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return { canvas: layer, ctx: lctx }
  }

  function buildVignetteLayer(): void {
    const made = makeLayer(cssW, cssH)
    vignetteLayer = null
    if (!made) return
    const g = made.ctx.createRadialGradient(
      cssW / 2,
      cssH * 0.44,
      1,
      cssW / 2,
      cssH * 0.5,
      Math.max(2, Math.max(cssW, cssH) * 0.78),
    )
    g.addColorStop(0, 'rgba(46,44,80,0.30)')
    g.addColorStop(0.55, 'rgba(10,10,20,0.28)')
    g.addColorStop(1, 'rgba(0,0,0,0.72)')
    made.ctx.fillStyle = g
    made.ctx.fillRect(0, 0, cssW, cssH)
    vignetteLayer = made.canvas
  }

  function buildDangerLayer(): void {
    const c = metrics.cellSize
    dangerLayerW = metrics.width + c * 0.36
    dangerLayerH = metrics.height + c * 0.36
    const made = makeLayer(dangerLayerW, dangerLayerH)
    dangerLayer = null
    if (!made) return
    const cx = dangerLayerW / 2
    const cy = dangerLayerH / 2
    const g = made.ctx.createRadialGradient(
      cx,
      cy,
      Math.max(1, dangerLayerH * 0.18),
      cx,
      cy,
      Math.max(2, Math.max(dangerLayerW, dangerLayerH) * 0.72),
    )
    g.addColorStop(0, 'rgba(255,40,70,0)')
    g.addColorStop(0.62, 'rgba(255,36,66,0.22)')
    g.addColorStop(1, 'rgba(255,26,58,0.72)')
    made.ctx.fillStyle = g
    made.ctx.fillRect(0, 0, dangerLayerW, dangerLayerH)
    dangerLayer = made.canvas
  }

  function layout(): void {
    const marginX = Math.max(8, Math.min(48, cssW * 0.04))
    const marginY = Math.max(8, Math.min(48, cssH * 0.05))
    const availW = Math.max(40, cssW - marginX * 2)
    const availH = Math.max(40, cssH - marginY * 2)

    const widthUnits = hasOpponent ? COLS * (1 + SIDE_FRAC + GAP_FRAC) : COLS
    const cell = Math.max(2, Math.min(availW / widthUnits, availH / ROWS))
    const boardW = cell * COLS
    const boardH = cell * ROWS
    const totalW = hasOpponent ? boardW * (1 + SIDE_FRAC + GAP_FRAC) : boardW

    metrics.cellSize = cell
    metrics.width = boardW
    metrics.height = boardH
    metrics.originX = Math.round((cssW - totalW) / 2)
    metrics.originY = Math.round((cssH - boardH) / 2)

    sideW = boardW * SIDE_FRAC
    sideH = boardH
    sideX = metrics.originX + boardW + boardW * GAP_FRAC
    sideY = metrics.originY

    sideHeaderH = Math.max(22, sideW * 0.34)
    sideCell = Math.max(0.5, Math.min(sideW / COLS, (sideH - sideHeaderH) / ROWS))
    sideGw = sideCell * COLS
    sideGh = sideCell * ROWS
    sideGx = sideX + (sideW - sideGw) / 2
    sideGy = sideY + sideHeaderH
    sidePad = sideCell * 0.3

    buildVignetteLayer()
    buildDangerLayer()

    fogGrad = ctx.createLinearGradient(0, metrics.originY, 0, metrics.originY + boardH)
    fogGrad.addColorStop(0, 'rgba(186,196,224,0.05)')
    fogGrad.addColorStop(0.45, 'rgba(196,206,234,0.17)')
    fogGrad.addColorStop(1, 'rgba(170,180,214,0.09)')

    fontGlyph = `${Math.round(cell * 0.44)}px ${UI_FONT}`
    fontName = `600 ${Math.round(Math.max(10, sideW * 0.11))}px ${UI_FONT}`
    fontScore = `700 ${Math.round(Math.max(11, sideW * 0.145))}px ${UI_FONT}`
    fontKo = `800 ${Math.round(Math.max(14, sideW * 0.24))}px ${UI_FONT}`
    fontHazard = `700 ${Math.round(Math.max(9, cell * 0.34))}px ${UI_FONT}`
    nameSource = ''
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect()
    cssW = Math.max(1, rect.width || canvas.clientWidth || window.innerWidth)
    cssH = Math.max(1, rect.height || canvas.clientHeight || window.innerHeight)
    dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))

    const bw = Math.max(1, Math.round(cssW * dpr))
    const bh = Math.max(1, Math.round(cssH * dpr))
    if (canvas.width !== bw) canvas.width = bw
    if (canvas.height !== bh) canvas.height = bh

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    layout()
  }

  // -- Background -----------------------------------------------------------

  function drawBackground(t: number, reduced: boolean): void {
    ctx.fillStyle = BG_COLOR
    ctx.fillRect(0, 0, cssW, cssH)

    for (let layer = 0; layer < STAR_LAYERS; layer++) {
      const drift = reduced ? 0 : (t * STAR_DRIFT[layer]) % 1
      ctx.fillStyle = STAR_TINT[layer]
      ctx.beginPath()
      for (let i = 0; i < STAR_COUNT; i++) {
        if (starLayer[i] !== layer) continue
        let ny = starY[i] - drift
        if (ny < 0) ny += 1
        const x = starX[i] * cssW
        const y = ny * cssH
        const r = starR[i]
        ctx.moveTo(x + r, y)
        ctx.arc(x, y, r, 0, TAU)
      }
      ctx.fill()
    }

    if (vignetteLayer) ctx.drawImage(vignetteLayer, 0, 0, cssW, cssH)
  }

  // -- Board ----------------------------------------------------------------

  /** `locked` = colours are dead: the frame goes cold grey, deliberately. */
  function drawBoardFrame(locked: boolean): void {
    const c = metrics.cellSize
    const ox = metrics.originX
    const oy = metrics.originY
    const w = metrics.width
    const h = metrics.height
    const pad = c * 0.18
    const radius = c * 0.55

    ctx.beginPath()
    ctx.roundRect(ox - pad, oy - pad, w + pad * 2, h + pad * 2, radius)
    ctx.fillStyle = locked ? 'rgba(10,11,16,0.95)' : 'rgba(7,7,13,0.94)'
    ctx.fill()

    ctx.fillStyle = 'rgba(255,255,255,0.022)'
    ctx.fillRect(ox, oy, w, c * TOP_KILL_ROW)

    if (locked) {
      ctx.fillStyle = 'rgba(104,112,132,0.05)'
      ctx.fillRect(ox, oy, w, h)
    }

    ctx.lineWidth = 1
    ctx.strokeStyle = locked ? 'rgba(206,212,228,0.05)' : 'rgba(180,200,255,0.05)'
    ctx.beginPath()
    for (let i = 1; i < COLS; i++) {
      const x = Math.round(ox + i * c) + 0.5
      ctx.moveTo(x, oy)
      ctx.lineTo(x, oy + h)
    }
    ctx.stroke()

    ctx.lineWidth = Math.max(1.5, c * 0.09)
    ctx.strokeStyle = locked ? 'rgba(142,150,170,0.38)' : 'rgba(122,146,214,0.34)'
    ctx.beginPath()
    ctx.roundRect(ox - pad, oy - pad, w + pad * 2, h + pad * 2, radius)
    ctx.stroke()
  }

  function drawKillLine(danger: boolean, t: number, reduced: boolean): void {
    const c = metrics.cellSize
    const ox = metrics.originX
    const w = metrics.width
    const y = Math.round(metrics.originY + TOP_KILL_ROW * c) + 0.5
    const pulse = reduced ? 0.75 : 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(t * 4.4))

    if (danger) {
      ctx.fillStyle = `rgba(255,48,80,${(0.1 * pulse).toFixed(3)})`
      ctx.fillRect(ox, y, w, c * 0.55)
    }

    ctx.setLineDash(KILL_DASH)
    ctx.lineDashOffset = reduced ? 0 : -((t * 22) % 32)

    if (danger) {
      ctx.lineWidth = Math.max(3, c * 0.26)
      ctx.strokeStyle = `rgba(255,60,90,${(0.16 * pulse).toFixed(3)})`
      ctx.beginPath()
      ctx.moveTo(ox, y)
      ctx.lineTo(ox + w, y)
      ctx.stroke()
    }

    ctx.lineWidth = Math.max(1.5, c * 0.05)
    ctx.strokeStyle = danger
      ? `rgba(255,96,120,${(0.95 * pulse).toFixed(3)})`
      : 'rgba(200,214,255,0.20)'
    ctx.beginPath()
    ctx.moveTo(ox, y)
    ctx.lineTo(ox + w, y)
    ctx.stroke()

    ctx.setLineDash(NO_DASH)
    ctx.lineDashOffset = 0
  }

  function drawCells(grid: Grid, armor: number[][] | undefined, override: string | undefined): void {
    const c = metrics.cellSize
    const ox = metrics.originX
    const oy = metrics.originY
    for (let r = 0; r < ROWS; r++) {
      const row = grid[r]
      if (!row) continue
      const arow = armor ? armor[r] : undefined
      const py = oy + r * c
      for (let col = 0; col < COLS; col++) {
        const v = row[col]
        if (v === null || v === undefined) continue
        const px = ox + col * c
        drawBlock(ctx, px, py, c, v, 1, override)
        if (arow !== undefined) {
          const a = arow[col]
          if (a !== undefined && a > 0) drawArmor(ctx, px, py, c, a)
        }
      }
    }
  }

  function dimBoard(): void {
    const c = metrics.cellSize
    const ox = metrics.originX - c * 0.18
    const oy = metrics.originY - c * 0.18
    const w = metrics.width + c * 0.36
    const h = metrics.height + c * 0.36

    ctx.save()
    ctx.beginPath()
    ctx.roundRect(ox, oy, w, h, c * 0.55)
    ctx.clip()
    ctx.globalCompositeOperation = 'saturation'
    ctx.globalAlpha = 0.7
    ctx.fillStyle = 'hsl(0,0%,50%)'
    ctx.fillRect(ox, oy, w, h)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = 'rgba(9,9,16,0.42)'
    ctx.fillRect(ox, oy, w, h)
    ctx.restore()
  }

  // -- Aim path -------------------------------------------------------------

  function drawAimPath(path: AimPoint[], t: number, reduced: boolean): void {
    const n = path.length
    if (n < 2) return
    const c = metrics.cellSize
    const ox = metrics.originX
    const oy = metrics.originY

    ctx.lineWidth = Math.max(1, c * 0.05)
    ctx.strokeStyle = 'rgba(178,220,255,0.13)'
    ctx.beginPath()
    ctx.moveTo(ox + path[0].x * c, oy + path[0].y * c)
    for (let i = 1; i < n; i++) ctx.lineTo(ox + path[i].x * c, oy + path[i].y * c)
    ctx.stroke()

    let total = 0
    for (let i = 1; i < n; i++) {
      total += Math.hypot((path[i].x - path[i - 1].x) * c, (path[i].y - path[i - 1].y) * c)
    }
    if (total <= 0) return

    const spacing = c * 0.46
    const march = reduced ? 0 : (t * c * 3.4) % spacing
    let next = spacing * 0.5 - march
    while (next < 0) next += spacing
    let travelled = 0

    ctx.fillStyle = 'rgba(214,242,255,0.85)'
    ctx.beginPath()
    for (let i = 1; i < n; i++) {
      const ax = ox + path[i - 1].x * c
      const ay = oy + path[i - 1].y * c
      const bx = ox + path[i].x * c
      const by = oy + path[i].y * c
      const dx = bx - ax
      const dy = by - ay
      const len = Math.hypot(dx, dy)
      if (len <= 0) continue
      while (next <= len) {
        const f = next / len
        const px = ax + dx * f
        const py = ay + dy * f
        const r = c * 0.085 * (1 - 0.4 * ((travelled + next) / total))
        ctx.moveTo(px + r, py)
        ctx.arc(px, py, r, 0, TAU)
        next += spacing
      }
      next -= len
      travelled += len
    }
    ctx.fill()

    // Impact marker + arrowhead on the final point.
    const ax = ox + path[n - 2].x * c
    const ay = oy + path[n - 2].y * c
    const bx = ox + path[n - 1].x * c
    const by = oy + path[n - 1].y * c
    const angle = Math.atan2(by - ay, bx - ax)

    ctx.strokeStyle = 'rgba(214,242,255,0.45)'
    ctx.lineWidth = Math.max(1, c * 0.05)
    ctx.beginPath()
    ctx.arc(bx, by, c * 0.4, 0, TAU)
    ctx.stroke()

    ctx.save()
    ctx.translate(bx, by)
    ctx.rotate(angle)
    ctx.fillStyle = 'rgba(224,246,255,0.9)'
    ctx.beginPath()
    ctx.moveTo(c * 0.3, 0)
    ctx.lineTo(-c * 0.12, c * 0.19)
    ctx.lineTo(-c * 0.12, -c * 0.19)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  // -- Pieces ---------------------------------------------------------------

  function drawPieceAt(
    cx: number,
    cy: number,
    piece: Piece,
    scale: number,
    alpha: number,
    override: string | undefined,
  ): void {
    const offs = pieceOffsets(piece)
    const c = metrics.cellSize
    const size = c * scale
    const half = size / 2
    const ox = metrics.originX
    const oy = metrics.originY
    const armor = piece.armor ?? 0
    for (let i = 0; i < offs.length; i++) {
      const o = offs[i]
      const px = ox + (cx + o.x * scale) * c - half
      const py = oy + (cy + o.y * scale) * c - half
      drawBlock(ctx, px, py, size, piece.colors[i], alpha, override)
      if (armor > 0) drawArmor(ctx, px, py, size, armor, alpha)
    }
  }

  function drawLauncher(
    state: GameState,
    t: number,
    reduced: boolean,
    override: string | undefined,
  ): void {
    const c = metrics.cellSize
    const px = metrics.originX + LAUNCH_X * c
    const py = metrics.originY + LAUNCH_Y * c
    const r = c * 0.7
    const armed = state.phase === 'aiming'

    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(state.aimAngle)
    ctx.beginPath()
    ctx.roundRect(-c * 0.24, r * 0.2, c * 0.48, c * 0.95, c * 0.16)
    ctx.fillStyle = 'rgba(58,70,116,0.85)'
    ctx.fill()
    ctx.lineWidth = Math.max(1, c * 0.05)
    ctx.strokeStyle = armed ? 'rgba(168,208,255,0.6)' : 'rgba(140,160,210,0.32)'
    ctx.stroke()
    ctx.restore()

    if (!reduced) {
      ctx.globalAlpha = 0.1 + 0.12 * (0.5 + 0.5 * Math.sin(t * 3))
      ctx.strokeStyle = '#8fd0ff'
      ctx.lineWidth = Math.max(1, c * 0.06)
      ctx.beginPath()
      ctx.arc(px, py, r * 1.28, 0, TAU)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    ctx.beginPath()
    ctx.arc(px, py, r, 0, TAU)
    ctx.fillStyle = 'rgba(14,16,28,0.92)'
    ctx.fill()
    ctx.lineWidth = Math.max(1.5, c * 0.1)
    ctx.strokeStyle = armed ? 'rgba(146,196,255,0.85)' : 'rgba(120,138,188,0.45)'
    ctx.stroke()

    if (armed) drawPieceCentered(LAUNCH_X, LAUNCH_Y, state.current, 0.44, override)
  }

  /** Same as drawPieceAt but centered on the shape's bounding box, not its pivot. */
  function drawPieceCentered(
    cx: number,
    cy: number,
    piece: Piece,
    scale: number,
    override: string | undefined,
  ): void {
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
    drawPieceAt(
      cx - ((minX + maxX) / 2) * scale,
      cy - ((minY + maxY) / 2) * scale,
      piece,
      scale,
      1,
      override,
    )
  }

  function drawFlying(f: FlyingPiece, override: string | undefined): void {
    drawPieceAt(f.x, f.y, f.piece, 1, 1, override)
  }

  // -- Powers / overlays ----------------------------------------------------

  function drawPowers(powers: PowerBubble[], t: number, reduced: boolean): void {
    const c = metrics.cellSize
    const ox = metrics.originX
    const oy = metrics.originY
    for (let i = 0; i < powers.length; i++) {
      const p = powers[i]
      const x = ox + p.x * c
      const y = oy + p.y * c
      const pulse = reduced ? 1 : 1 + 0.09 * Math.sin(t * 4.2 + p.id * 1.7)
      const r = c * 0.4 * pulse

      ctx.fillStyle = 'rgba(179,136,255,0.14)'
      ctx.beginPath()
      ctx.arc(x, y, r * 1.85, 0, TAU)
      ctx.fill()
      ctx.fillStyle = 'rgba(179,136,255,0.26)'
      ctx.beginPath()
      ctx.arc(x, y, r * 1.3, 0, TAU)
      ctx.fill()

      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.fillStyle = 'rgba(26,20,44,0.94)'
      ctx.fill()
      ctx.lineWidth = Math.max(1, c * 0.07)
      ctx.strokeStyle = POWER_COLOR
      ctx.stroke()

      ctx.font = fontGlyph
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#f2ecff'
      ctx.fillText(CURSE_GLYPH[p.kind], x, y + c * 0.02)
    }
  }

  function drawFog(): void {
    if (!fogGrad) return
    const c = metrics.cellSize
    ctx.fillStyle = fogGrad
    ctx.fillRect(
      metrics.originX - c * 0.18,
      metrics.originY - c * 0.18,
      metrics.width + c * 0.36,
      metrics.height + c * 0.36,
    )
  }

  /**
   * Active-hazard announcement: a translucent slab just below the kill line,
   * with the label and a countdown bar. It sits above the stack and below the
   * launcher, so it never hides the launcher nor the lane being aimed into, and
   * it stays translucent enough to read the board through.
   */
  function drawHazardBanner(hazards: ActiveHazard[], reduced: boolean): void {
    const c = metrics.cellSize
    const padX = c * 0.34
    const x = metrics.originX + padX
    const bw = metrics.width - padX * 2
    const bh = c * 0.86
    const gapY = c * 0.14
    if (bw <= c || bh <= 4) return

    let y = metrics.originY + TOP_KILL_ROW * c + c * 0.36
    const n = Math.min(hazards.length, MAX_HAZARD_BANNERS)
    const prevAlpha = ctx.globalAlpha

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = fontHazard

    for (let i = 0; i < n; i++) {
      const hz = hazards[i]
      const total = HAZARD_DURATION[hz.kind]
      const shown = total - hz.remaining
      const leaving = HAZARD_BANNER_HOLD - shown
      const alpha = reduced
        ? shown < HAZARD_BANNER_HOLD
          ? 1
          : 0
        : Math.max(
            0,
            Math.min(1, shown / HAZARD_FADE_IN, hz.remaining / HAZARD_FADE_OUT, leaving / 0.5),
          )
      if (alpha <= 0.01) {
        y += bh + gapY
        continue
      }
      const accent = HAZARD_ACCENT[hz.kind]

      ctx.globalAlpha = prevAlpha * alpha
      ctx.beginPath()
      ctx.roundRect(x, y, bw, bh, bh * 0.3)
      ctx.fillStyle = 'rgba(8,9,17,0.82)'
      ctx.fill()
      ctx.lineWidth = Math.max(1, c * 0.045)
      ctx.strokeStyle = accent
      ctx.globalAlpha = prevAlpha * alpha * 0.5
      ctx.stroke()

      ctx.globalAlpha = prevAlpha * alpha
      const label = HAZARD_LABEL[hz.kind]
      const maxTextW = bw - c * 0.5
      const textW = ctx.measureText(label).width
      const ty = y + bh * 0.4
      ctx.fillStyle = '#eaf0ff'
      if (textW > maxTextW && textW > 0) {
        // Squeeze rather than clip: the whole warning must stay readable.
        ctx.save()
        ctx.translate(x + bw / 2, ty)
        ctx.scale(maxTextW / textW, 1)
        ctx.fillText(label, 0, 0)
        ctx.restore()
      } else {
        ctx.fillText(label, x + bw / 2, ty)
      }

      // Countdown: remaining / total, drained left to right.
      const barH = Math.max(2, c * 0.07)
      const barX = x + c * 0.24
      const barW = bw - c * 0.48
      const barY = y + bh - barH - bh * 0.16
      ctx.beginPath()
      ctx.roundRect(barX, barY, barW, barH, barH / 2)
      ctx.fillStyle = 'rgba(226,234,255,0.14)'
      ctx.fill()
      const frac = Math.max(0, Math.min(1, hz.remaining / total))
      if (frac > 0) {
        ctx.beginPath()
        ctx.roundRect(barX, barY, Math.max(barH, barW * frac), barH, barH / 2)
        ctx.fillStyle = accent
        ctx.fill()
      }

      y += bh + gapY
    }

    ctx.globalAlpha = prevAlpha
  }

  function drawDangerVignette(t: number, reduced: boolean): void {
    if (!dangerLayer) return
    const c = metrics.cellSize
    ctx.globalAlpha = reduced ? 0.2 : 0.2 + 0.22 * (0.5 + 0.5 * Math.sin(t * 5.2))
    ctx.drawImage(
      dangerLayer,
      metrics.originX - c * 0.18,
      metrics.originY - c * 0.18,
      dangerLayerW,
      dangerLayerH,
    )
    ctx.globalAlpha = 1
  }

  function drawFlash(): void {
    const a = juice.flashAlpha
    if (a <= 0) return
    // Padded so a shaken/rotated board stays covered by the axis-aligned tint.
    const c = metrics.cellSize
    ctx.globalAlpha = Math.min(1, a)
    ctx.fillStyle = juice.flashColor
    ctx.fillRect(
      metrics.originX - c * 0.6,
      metrics.originY - c * 0.6,
      metrics.width + c * 1.2,
      metrics.height + c * 1.2,
    )
    ctx.globalAlpha = 1
  }

  // -- Opponent mini-board --------------------------------------------------

  /** Ellipsizes to the sidebar width; only re-measured when the name changes. */
  function shortName(name: string, maxWidth: number): string {
    if (name !== nameSource) {
      nameSource = name
      nameShown = name
      let cut = name.length
      while (cut > 1 && ctx.measureText(nameShown).width > maxWidth) {
        cut--
        nameShown = `${name.slice(0, cut)}…`
      }
    }
    return nameShown
  }

  function drawOpponent(view: OpponentView): void {
    const headerH = sideHeaderH
    const cell = sideCell
    const gw = sideGw
    const gh = sideGh
    const gx = sideGx
    const gy = sideGy
    const pad = sidePad

    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.font = fontName
    ctx.fillStyle = 'rgba(224,230,255,0.82)'
    ctx.fillText(shortName(view.name, gw), gx, sideY + headerH * 0.36)
    ctx.font = fontScore
    ctx.fillStyle = view.danger ? '#ff7d9c' : 'rgba(255,255,255,0.62)'
    ctx.fillText(String(view.score), gx, sideY + headerH * 0.8)

    ctx.beginPath()
    ctx.roundRect(gx - pad, gy - pad, gw + pad * 2, gh + pad * 2, cell * 0.7)
    ctx.fillStyle = 'rgba(7,7,13,0.94)'
    ctx.fill()
    ctx.lineWidth = Math.max(1, cell * 0.16)
    ctx.strokeStyle = view.danger ? 'rgba(255,80,110,0.55)' : 'rgba(122,146,214,0.28)'
    ctx.stroke()

    for (let r = 0; r < ROWS; r++) {
      const row = view.grid[r]
      if (!row) continue
      const py = gy + r * cell
      for (let col = 0; col < COLS; col++) {
        const v = row[col]
        if (v === null || v === undefined) continue
        drawBlock(ctx, gx + col * cell, py, cell, v)
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.lineWidth = 1
    const killY = Math.round(gy + TOP_KILL_ROW * cell) + 0.5
    ctx.beginPath()
    ctx.moveTo(gx, killY)
    ctx.lineTo(gx + gw, killY)
    ctx.stroke()

    if (view.danger) {
      ctx.fillStyle = 'rgba(255,40,70,0.13)'
      ctx.fillRect(gx, gy, gw, gh)
    }

    if (view.gameOver) {
      ctx.fillStyle = 'rgba(6,6,11,0.74)'
      ctx.fillRect(gx - pad, gy - pad, gw + pad * 2, gh + pad * 2)
      ctx.font = fontKo
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#ff5c8a'
      ctx.fillText('K.O.', gx + gw / 2, gy + gh / 2)
    }
  }

  /**
   * Holds the sidebar from the first frame of a versus match until the first
   * opponent snapshot arrives: same box, empty board, dimmed, so the reserved
   * space reads as "not connected yet" rather than as a rendering hole.
   */
  function drawOpponentPlaceholder(t: number, reduced: boolean): void {
    const cell = sideCell
    const gw = sideGw
    const gh = sideGh
    const gx = sideGx
    const gy = sideGy
    const pad = sidePad

    // The name/score slots stay blank; two dim slugs keep the header readable
    // as "pending" instead of looking like text that failed to draw.
    ctx.fillStyle = 'rgba(190,200,244,0.09)'
    ctx.beginPath()
    ctx.roundRect(gx, sideY + sideHeaderH * 0.14, gw * 0.56, sideHeaderH * 0.2, sideHeaderH * 0.1)
    ctx.roundRect(gx, sideY + sideHeaderH * 0.5, gw * 0.32, sideHeaderH * 0.22, sideHeaderH * 0.11)
    ctx.fill()

    ctx.beginPath()
    ctx.roundRect(gx - pad, gy - pad, gw + pad * 2, gh + pad * 2, cell * 0.7)
    ctx.fillStyle = 'rgba(7,7,13,0.72)'
    ctx.fill()
    ctx.setLineDash(WAIT_DASH)
    ctx.lineWidth = Math.max(1, cell * 0.16)
    ctx.strokeStyle = 'rgba(122,146,214,0.22)'
    ctx.stroke()
    ctx.setLineDash(NO_DASH)

    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 1
    const killY = Math.round(gy + TOP_KILL_ROW * cell) + 0.5
    ctx.beginPath()
    ctx.moveTo(gx, killY)
    ctx.lineTo(gx + gw, killY)
    ctx.stroke()

    ctx.font = fontName
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.globalAlpha = reduced ? 0.5 : 0.36 + 0.2 * (0.5 + 0.5 * Math.sin(t * 2.2))
    ctx.fillStyle = '#c6cee6'
    ctx.fillText('waiting…', gx + gw / 2, gy + gh / 2)
    ctx.globalAlpha = 1
  }

  // -- Frame ----------------------------------------------------------------

  function render(state: GameState, opts: RenderOptions): void {
    if (cssW <= 1 || cssH <= 1) resize()

    // Reserve the sidebar for the whole match. `state.versus` is known from the
    // very first frame, whereas opts.opponent only turns up with the first
    // network snapshot — laying out on that made the board jump mid-play.
    if (state.versus !== hasOpponent) {
      hasOpponent = state.versus
      layout()
    }

    const t = (performance.now() - t0) / 1000
    const reduced = opts.reducedMotion

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalAlpha = 1
    drawBackground(t, reduced)

    const bcx = metrics.originX + metrics.width / 2
    const bcy = metrics.originY + metrics.height / 2
    ctx.save()
    ctx.translate(bcx + juice.offsetX, bcy + juice.offsetY)
    ctx.rotate(juice.rotation)
    ctx.translate(-bcx, -bcy)

    // Colour lock (hardcore, or a running `stone` hazard) repaints every block
    // as stone; the board itself goes cold so it reads as intentional.
    const stone = state.colorsLocked ? STONE_HEX : undefined

    drawBoardFrame(stone !== undefined)
    drawKillLine(state.danger, t, reduced)
    drawCells(state.grid, state.armor, stone)
    if (opts.aimPath) drawAimPath(opts.aimPath, t, reduced)
    drawLauncher(state, t, reduced, stone)
    if (state.flying) drawFlying(state.flying, stone)
    if (state.powers.length > 0) drawPowers(state.powers, t, reduced)
    if (state.hazards && state.hazards.length > 0) drawHazardBanner(state.hazards, reduced)
    if (state.phase === 'gameover') dimBoard()
    if (opts.fogged) drawFog()
    if (state.danger) drawDangerVignette(t, reduced)

    ctx.restore()

    if (hasOpponent) {
      if (opts.opponent) drawOpponent(opts.opponent)
      else drawOpponentPlaceholder(t, reduced)
    }
    drawFlash()

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalAlpha = 1
    particles.render(ctx)
  }

  function boardMetrics(): BoardMetrics {
    return {
      originX: metrics.originX,
      originY: metrics.originY,
      cellSize: metrics.cellSize,
      width: metrics.width,
      height: metrics.height,
    }
  }

  function toScreen(x: number, y: number): { x: number; y: number } {
    return { x: metrics.originX + x * metrics.cellSize, y: metrics.originY + y * metrics.cellSize }
  }

  resize()

  return { resize, render, boardMetrics, toScreen }
}
