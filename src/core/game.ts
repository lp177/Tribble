import {
  CHAIN_MULT_CAP,
  CLEARS_PER_LEVEL,
  COLS,
  CURSE_DURATION,
  CURSE_KINDS,
  DANGER_ROWS,
  INITIAL_ROWS,
  LAUNCH_SPEED,
  LAUNCH_X,
  LAUNCH_Y,
  MAX_AIM_ANGLE,
  MAX_INVENTORY,
  MAX_POWERS,
  POWER_RADIUS,
  POWER_RISE_SPEED,
  RESOLVE_STEP,
  RISE_MIN,
  RISE_START,
  RISE_TAU,
  RISE_WARNING_AT,
  ROWS,
  TOP_KILL_ROW,
  pieceOffsets,
  type AimPoint,
  type CurseKind,
  type EventBus,
  type FlyingPiece,
  type Game,
  type GameEventName,
  type GameEvents,
  type GameOptions,
  type GameState,
  type Grid,
  type Piece,
  type PieceKind,
  type PlacedCell,
  type PowerBubble,
  type Rng,
  type SaveGame,
} from '../types'
import {
  applyGravity,
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
import { makeBag, makePiece, pieceCells, rotatePiece } from './piece'
import { createRng } from './rng'

/** Decorrelates the garbage/power stream from the piece stream (see DESIGN.md). */
const MISC_SEED_XOR = 0x9e3779b9
/** A flight substep never travels further than this, so nothing tunnels. */
const MAX_SUBSTEP_CELLS = 0.25
const WALL_EPS = 1e-6
const TIME_EPS = 1e-9
/** Bisections used to pin the exact contact point; makes the sim step-size independent. */
const REFINE_ITERATIONS = 20
const LOCK_SEARCH_STEPS = 40
const LOCK_LATERAL = [0, -1, 1, -2, 2] as const
const AIM_MAX_STEPS = 1200
const EMPTY_PAYLOAD: Record<string, never> = {}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

type Erased = (payload: never) => void

export function createEventBus(): EventBus {
  const listeners = new Map<GameEventName, Erased[]>()

  function off<K extends GameEventName>(name: K, fn: (payload: GameEvents[K]) => void): void {
    const arr = listeners.get(name)
    if (!arr) return
    const i = arr.indexOf(fn as Erased)
    if (i >= 0) arr.splice(i, 1)
  }

  function on<K extends GameEventName>(name: K, fn: (payload: GameEvents[K]) => void): () => void {
    let arr = listeners.get(name)
    if (!arr) {
      arr = []
      listeners.set(name, arr)
    }
    arr.push(fn as Erased)
    return () => off(name, fn)
  }

  function emit<K extends GameEventName>(name: K, payload: GameEvents[K]): void {
    const arr = listeners.get(name)
    if (arr === undefined || arr.length === 0) return
    // Snapshot: a handler is allowed to unsubscribe itself while we dispatch.
    const snapshot = arr.slice()
    for (let i = 0; i < snapshot.length; i++) {
      ;(snapshot[i] as (p: GameEvents[K]) => void)(payload)
    }
  }

  return {
    on,
    off,
    emit,
    clear(): void {
      listeners.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Shared flight kinematics (used by the engine and by computeAimPath so the
// aim preview and a real launch agree on where a piece lands)
// ---------------------------------------------------------------------------

interface Mover {
  piece: Piece
  x: number
  y: number
  vx: number
  vy: number
}

function makeScratch(): PlacedCell[] {
  return [
    { row: 0, col: 0, color: 0 },
    { row: 0, col: 0, color: 0 },
    { row: 0, col: 0, color: 0 },
    { row: 0, col: 0, color: 0 },
  ]
}

/** Fills a reusable cell buffer; valid until the next call with the same buffer. */
function fillCells(out: PlacedCell[], piece: Piece, x: number, y: number): PlacedCell[] {
  const offs = pieceOffsets(piece)
  for (let i = 0; i < offs.length; i++) {
    const off = offs[i]
    const cell = out[i]
    cell.row = Math.floor(y + off.y)
    cell.col = Math.floor(x + off.x)
    cell.color = piece.colors[i]
  }
  return out
}

const BOUNDS = { lo: 0, hi: 0 }

/** Pivot x range that keeps every cell of the piece between the side walls. */
function pieceXBounds(piece: Piece, out: { lo: number; hi: number }): void {
  const offs = pieceOffsets(piece)
  let minX = offs[0].x
  let maxX = offs[0].x
  for (let i = 1; i < offs.length; i++) {
    if (offs[i].x < minX) minX = offs[i].x
    if (offs[i].x > maxX) maxX = offs[i].x
  }
  out.lo = -minX
  out.hi = COLS - maxX - WALL_EPS
}

function refineContact(grid: Grid, m: Mover, hx: number, hy: number, scratch: PlacedCell[]): void {
  const x0 = m.x
  const y0 = m.y
  let lo = 0
  let hi = 1
  for (let i = 0; i < REFINE_ITERATIONS; i++) {
    const mid = (lo + hi) * 0.5
    const mx = x0 + (hx - x0) * mid
    const my = y0 + (hy - y0) * mid
    if (collides(grid, fillCells(scratch, m.piece, mx, my))) hi = mid
    else lo = mid
  }
  m.x = x0 + (hx - x0) * lo
  m.y = y0 + (hy - y0) * lo
}

/**
 * Advances a mover by dt, reflecting off the side walls at the exact crossing
 * point. Returns true on impact, leaving the mover at the refined last free
 * position.
 */
function stepMover(
  grid: Grid,
  m: Mover,
  dt: number,
  scratch: PlacedCell[],
  onBounce: ((x: number, y: number) => void) | null,
): boolean {
  let remaining = dt
  for (let guard = 0; guard < 4 && remaining > TIME_EPS; guard++) {
    pieceXBounds(m.piece, BOUNDS)
    const nx = m.x + m.vx * remaining
    const ny = m.y + m.vy * remaining

    let wall = 0
    let t = 1
    if (nx < BOUNDS.lo && m.vx < 0) {
      wall = -1
      t = (BOUNDS.lo - m.x) / (nx - m.x)
    } else if (nx > BOUNDS.hi && m.vx > 0) {
      wall = 1
      t = (BOUNDS.hi - m.x) / (nx - m.x)
    }
    if (wall !== 0) t = t >= 0 && t <= 1 ? t : t < 0 ? 0 : 1

    const tx = wall === -1 ? BOUNDS.lo : wall === 1 ? BOUNDS.hi : nx
    const ty = m.y + (ny - m.y) * t

    if (collides(grid, fillCells(scratch, m.piece, tx, ty))) {
      refineContact(grid, m, tx, ty, scratch)
      return true
    }

    m.x = tx
    m.y = ty
    if (wall === 0) return false

    m.vx = -m.vx
    if (onBounce) onBounce(tx, ty)
    remaining *= 1 - t
  }
  return false
}

const PLACE = { x: 0, y: 0 }

/**
 * Grid-aligned resting placement for a piece stopped at (px, py): the snapped
 * pivot when it is free, otherwise the free candidate closest to the contact
 * point, searched backwards along the inverse velocity with small lateral
 * offsets. Bounded, and never returns an overlapping placement.
 */
function findLockPlacement(
  grid: Grid,
  piece: Piece,
  px: number,
  py: number,
  vx: number,
  vy: number,
  scratch: PlacedCell[],
): void {
  const sx = Math.floor(px) + 0.5
  const sy = Math.floor(py) + 0.5
  if (!collides(grid, fillCells(scratch, piece, sx, sy))) {
    PLACE.x = sx
    PLACE.y = sy
    return
  }

  const speed = Math.hypot(vx, vy)
  const ux = speed > 0 ? vx / speed : 0
  const uy = speed > 0 ? vy / speed : 1

  let bestX = sx
  let bestY = sy
  let bestD = Infinity
  for (let k = 0; k <= LOCK_SEARCH_STEPS; k++) {
    const back = k * 0.5
    const baseX = px - ux * back
    const baseY = py - uy * back
    for (let l = 0; l < LOCK_LATERAL.length; l++) {
      const cx = Math.floor(baseX) + 0.5 + LOCK_LATERAL[l]
      const cy = Math.floor(baseY) + 0.5
      if (collides(grid, fillCells(scratch, piece, cx, cy))) continue
      const d = (cx - px) * (cx - px) + (cy - py) * (cy - py)
      if (d < bestD) {
        bestD = d
        bestX = cx
        bestY = cy
      }
    }
  }
  if (bestD < Infinity) {
    PLACE.x = bestX
    PLACE.y = bestY
    return
  }

  // Board jammed around the contact: rise straight out of it. Whatever ends up
  // above the board triggers the kill check after the settle.
  let y = sy
  for (let i = 0; i <= ROWS + 4; i++) {
    if (!collides(grid, fillCells(scratch, piece, sx, y))) break
    y -= 1
  }
  PLACE.x = sx
  PLACE.y = y
}

function settle(grid: Grid, piece: Piece, x: number, y: number, scratch: PlacedCell[]): number {
  let py = y
  while (!collides(grid, fillCells(scratch, piece, x, py + 1))) py += 1
  return py
}

function clonePiece(p: Piece): Piece {
  return { kind: p.kind, rot: p.rot, colors: [p.colors[0], p.colors[1], p.colors[2], p.colors[3]] }
}

function drawFrom(bag: PieceKind[], rng: Rng): Piece {
  if (bag.length === 0) {
    const fresh = makeBag(rng)
    for (let i = 0; i < fresh.length; i++) bag.push(fresh[i])
  }
  const kind = bag.shift() ?? 'I'
  return makePiece(kind, rng)
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function createGame(opts: GameOptions): Game {
  return buildGame(opts, null)
}

export function loadGame(save: SaveGame, opts?: Partial<GameOptions>): Game {
  return buildGame({ seed: opts?.seed ?? 0, versus: opts?.versus ?? false }, save)
}

function buildGame(opts: GameOptions, save: SaveGame | null): Game {
  const seed = opts.seed >>> 0
  const bagRng = createRng(seed)
  const miscRng = createRng(seed ^ MISC_SEED_XOR)
  const bag: PieceKind[] = []
  const scratch = makeScratch()
  const bus = createEventBus()
  const mask = new Uint8Array(ROWS * COLS)
  const powerBase = new Map<number, number>()

  const grid: Grid = save ? flatToGrid(save.grid) : emptyGrid()
  if (save) {
    bagRng.setState(save.bagRngState)
    miscRng.setState(save.miscRngState)
    for (let i = 0; i < save.bag.length; i++) bag.push(save.bag[i])
  } else {
    for (let i = 0; i < INITIAL_ROWS; i++) insertGarbageRow(grid, miscRng)
  }

  const state: GameState = {
    grid,
    phase: 'aiming',
    current: save ? clonePiece(save.current) : drawFrom(bag, bagRng),
    next: save ? clonePiece(save.next) : drawFrom(bag, bagRng),
    flying: null,
    aimAngle: save ? clamp(save.aimAngle, -MAX_AIM_ANGLE, MAX_AIM_ANGLE) : 0,
    score: save ? save.score : 0,
    level: save ? save.level : 1,
    clearsTotal: save ? save.clearsTotal : 0,
    chain: 0,
    combo: save ? save.combo : 0,
    elapsed: save ? save.elapsed : 0,
    riseTimer: save ? save.riseTimer : RISE_START,
    riseInterval: save ? save.riseInterval : RISE_START,
    danger: stackTopRow(grid) <= TOP_KILL_ROW + DANGER_ROWS,
    versus: opts.versus === true,
    powers: [],
    inventory: [],
    activeCurses: [],
  }

  let resolveTimer = 0
  let clearedThisLaunch = false
  let clearsThisLaunch = 0
  let powerSpawnedThisResolve = false
  let riseWarned = false
  let gameOverEmitted = false
  let nextPowerId = 1

  const onBounce = (x: number, y: number): void => {
    bus.emit('bounce', { x, y })
  }

  // -- helpers --------------------------------------------------------------

  function hasCurse(kind: CurseKind): boolean {
    for (let i = 0; i < state.activeCurses.length; i++) {
      if (state.activeCurses[i].kind === kind) return true
    }
    return false
  }

  function updateDanger(): void {
    const on = stackTopRow(state.grid) <= TOP_KILL_ROW + DANGER_ROWS
    if (on !== state.danger) {
      state.danger = on
      bus.emit('danger', { on })
    }
  }

  function gameOver(): void {
    if (gameOverEmitted) return
    gameOverEmitted = true
    state.phase = 'gameover'
    state.flying = null
    bus.emit('gameOver', { score: state.score })
  }

  /** Indirection on purpose: keeps callers free of stale phase narrowing. */
  function isOver(): boolean {
    return state.phase === 'gameover'
  }

  function checkKill(): boolean {
    if (state.phase === 'gameover') return true
    if (stackTopRow(state.grid) < TOP_KILL_ROW) {
      gameOver()
      return true
    }
    return false
  }

  // -- rise -----------------------------------------------------------------

  function tickRise(dt: number): void {
    const scale = hasCurse('speed') ? 2 : 1
    state.riseTimer -= dt * scale
    if (!riseWarned && state.riseTimer < RISE_WARNING_AT) {
      riseWarned = true
      bus.emit('riseWarning', EMPTY_PAYLOAD)
    }
    let guard = 0
    while (state.riseTimer <= 0 && guard++ < 8 && state.phase !== 'gameover') {
      insertGarbageRow(state.grid, miscRng)
      bus.emit('rise', { rows: 1 })
      state.riseInterval = RISE_MIN + (RISE_START - RISE_MIN) * Math.exp(-state.elapsed / RISE_TAU)
      state.riseTimer = state.riseInterval
      riseWarned = false
      updateDanger()
      checkKill()
    }
  }

  // -- flight ---------------------------------------------------------------

  function catchPowers(f: FlyingPiece): void {
    if (state.inventory.length >= MAX_INVENTORY) return
    const offs = pieceOffsets(f.piece)
    for (let i = state.powers.length - 1; i >= 0; i--) {
      const p = state.powers[i]
      for (let j = 0; j < offs.length; j++) {
        const dx = f.x + offs[j].x - p.x
        const dy = f.y + offs[j].y - p.y
        if (dx * dx + dy * dy > POWER_RADIUS * POWER_RADIUS) continue
        state.powers.splice(i, 1)
        powerBase.delete(p.id)
        state.inventory.push(p.kind)
        bus.emit('powerCaught', { kind: p.kind })
        if (state.inventory.length >= MAX_INVENTORY) return
        break
      }
    }
  }

  function advanceFlight(dt: number): void {
    const f = state.flying
    if (!f) return
    const speed = Math.hypot(f.vx, f.vy)
    if (!(speed > 0)) return
    const maxDt = MAX_SUBSTEP_CELLS / speed
    let remaining = dt
    let guard = 0
    while (remaining > TIME_EPS && guard++ < 4096) {
      const step = remaining > maxDt ? maxDt : remaining
      remaining -= step
      if (stepMover(state.grid, f, step, scratch, onBounce)) {
        impactAndLock(f, speed)
        return
      }
      if (state.versus && state.powers.length > 0) catchPowers(f)
    }
  }

  function impactAndLock(f: FlyingPiece, speed: number): void {
    findLockPlacement(state.grid, f.piece, f.x, f.y, f.vx, f.vy, scratch)
    const px = PLACE.x
    const py = settle(state.grid, f.piece, px, PLACE.y, scratch)
    const cells = pieceCells(f.piece, px, py)

    state.flying = null
    bus.emit('impact', { x: px, y: py, speed })

    let aboveBoard = false
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      if (cell.row < 0) {
        aboveBoard = true
        continue
      }
      state.grid[cell.row][cell.col] = cell.color
    }
    bus.emit('lock', { cells })
    updateDanger()

    if (aboveBoard) {
      gameOver()
      return
    }
    startResolving()
  }

  // -- resolution -----------------------------------------------------------

  function startResolving(): void {
    state.phase = 'resolving'
    state.chain = 0
    clearedThisLaunch = false
    clearsThisLaunch = 0
    powerSpawnedThisResolve = false
    resolveTimer = RESOLVE_STEP
    resolveStep()
  }

  function maybeSpawnPower(cx: number, cy: number): void {
    if (!state.versus || powerSpawnedThisResolve) return
    if (state.powers.length >= MAX_POWERS) return
    const chance = 0.3 + 0.1 * (state.chain - 1)
    if (miscRng.next() >= chance) return
    const kind = miscRng.pick(CURSE_KINDS)
    const power: PowerBubble = { id: nextPowerId++, kind, x: cx, y: cy, age: 0 }
    powerBase.set(power.id, power.x)
    state.powers.push(power)
    powerSpawnedThisResolve = true
    bus.emit('powerSpawn', { power })
  }

  function resolveStep(): void {
    const lines = findLines(state.grid)
    const matches = findMatches(state.grid)
    if (lines.length === 0 && matches.length === 0) {
      finishResolution()
      return
    }

    state.chain++
    mask.fill(0)
    let sumX = 0
    let sumY = 0
    let count = 0
    for (let i = 0; i < lines.length; i++) {
      const r = lines[i]
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c
        if (mask[idx] !== 0) continue
        mask[idx] = 1
        sumX += c + 0.5
        sumY += r + 0.5
        count++
      }
    }
    for (let i = 0; i < matches.length; i++) {
      const cells = matches[i].cells
      for (let j = 0; j < cells.length; j++) {
        const idx = cells[j].row * COLS + cells[j].col
        if (mask[idx] !== 0) continue
        mask[idx] = 1
        sumX += cells[j].col + 0.5
        sumY += cells[j].row + 0.5
        count++
      }
    }
    for (let r = 0; r < ROWS; r++) {
      const row = state.grid[r]
      for (let c = 0; c < COLS; c++) {
        if (mask[r * COLS + c] !== 0) row[c] = null
      }
    }

    const cx = count > 0 ? sumX / count : LAUNCH_X
    const cy = count > 0 ? sumY / count : LAUNCH_Y

    const chainMult = Math.min(Math.pow(2, state.chain - 1), CHAIN_MULT_CAP)
    let raw = 0
    for (let i = 0; i < matches.length; i++) raw += 40 * matches[i].cells.length * chainMult
    if (lines.length > 0) raw += Math.round(120 * Math.pow(lines.length, 1.5) * chainMult)
    const delta = Math.round(raw * (1 + state.combo * 0.1) * (1 + (state.level - 1) * 0.1))
    state.score += delta

    clearedThisLaunch = true
    clearsThisLaunch += lines.length + matches.length

    bus.emit('clear', { lines, matches, chain: state.chain, score: delta, cx, cy })
    bus.emit('score', { delta, cx, cy })
    if (state.chain >= 2) bus.emit('chainStep', { chain: state.chain })
    maybeSpawnPower(cx, cy)

    if (applyGravity(state.grid)) bus.emit('fall', EMPTY_PAYLOAD)
    updateDanger()
  }

  function finishResolution(): void {
    state.combo = clearedThisLaunch ? state.combo + 1 : 0
    state.clearsTotal += clearsThisLaunch
    const level = 1 + Math.floor(state.clearsTotal / CLEARS_PER_LEVEL)
    if (level > state.level) {
      state.level = level
      bus.emit('levelUp', { level })
    }
    state.chain = 0
    updateDanger()
    if (checkKill()) return

    state.current = state.next
    state.next = drawFrom(bag, bagRng)
    state.flying = null
    state.phase = 'aiming'
  }

  // -- curses & powers ------------------------------------------------------

  function tickCurses(dt: number): void {
    for (let i = state.activeCurses.length - 1; i >= 0; i--) {
      const curse = state.activeCurses[i]
      curse.remaining -= dt
      if (curse.remaining > 0) continue
      state.activeCurses.splice(i, 1)
      bus.emit('curseExpired', { kind: curse.kind })
    }
  }

  function updatePowers(dt: number): void {
    for (let i = state.powers.length - 1; i >= 0; i--) {
      const p = state.powers[i]
      p.age += dt
      p.y -= POWER_RISE_SPEED * dt
      let base = powerBase.get(p.id)
      if (base === undefined) {
        base = p.x
        powerBase.set(p.id, base)
      }
      p.x = clamp(base + Math.sin(p.age * 3) * 0.4, 0.5, COLS - 0.5)
      if (p.y < 1) {
        state.powers.splice(i, 1)
        powerBase.delete(p.id)
        bus.emit('powerLost', { id: p.id })
      }
    }
  }

  // -- public API -----------------------------------------------------------

  function update(dt: number): void {
    if (state.phase === 'gameover' || !(dt > 0)) return
    state.elapsed += dt

    if (state.activeCurses.length > 0) tickCurses(dt)
    if (state.powers.length > 0) updatePowers(dt)

    const wasResolving = state.phase === 'resolving'
    if (state.phase === 'aiming' || state.phase === 'flying') tickRise(dt)

    if (isOver()) return // tickRise can end the run
    if (state.phase === 'flying') advanceFlight(dt)

    if (wasResolving && state.phase === 'resolving') {
      resolveTimer -= dt
      let guard = 0
      while (state.phase === 'resolving' && resolveTimer <= 0 && guard++ < 64) {
        resolveTimer += RESOLVE_STEP
        resolveStep()
      }
    }
  }

  function setAim(angle: number): void {
    if (state.phase !== 'aiming') return
    state.aimAngle = clamp(angle, -MAX_AIM_ANGLE, MAX_AIM_ANGLE)
  }

  function aimBy(delta: number): void {
    if (state.phase !== 'aiming') return
    state.aimAngle = clamp(state.aimAngle + delta, -MAX_AIM_ANGLE, MAX_AIM_ANGLE)
  }

  function rotate(dir: 1 | -1): void {
    if (state.phase !== 'aiming' && state.phase !== 'flying') return
    if (hasCurse('lockRotate')) return

    if (state.phase === 'aiming') {
      state.current = rotatePiece(state.current, dir)
    } else {
      const f = state.flying
      if (!f) return
      f.piece = rotatePiece(f.piece, dir)
      pieceXBounds(f.piece, BOUNDS)
      f.x = clamp(f.x, BOUNDS.lo, BOUNDS.hi)
    }
    bus.emit('rotate', { dir })
  }

  function launch(): void {
    if (state.phase !== 'aiming') return
    const angle = state.aimAngle
    state.flying = {
      piece: state.current,
      x: LAUNCH_X,
      y: LAUNCH_Y,
      vx: Math.sin(angle) * LAUNCH_SPEED,
      vy: Math.cos(angle) * LAUNCH_SPEED,
    }
    state.phase = 'flying'
    bus.emit('launch', { angle })
  }

  function useCurse(): CurseKind | null {
    return state.inventory.shift() ?? null
  }

  function addGarbage(rows: number): void {
    if (state.phase === 'gameover' || rows <= 0) return
    for (let i = 0; i < rows; i++) insertGarbageRow(state.grid, miscRng)
    bus.emit('rise', { rows })
    updateDanger()
    checkKill()
  }

  function applyCurse(kind: CurseKind): void {
    if (state.phase === 'gameover') return
    bus.emit('curseApplied', { kind })

    if (kind === 'garbage') {
      addGarbage(2)
      return
    }
    if (kind === 'scramble') {
      scrambleColors(state.grid, miscRng, 12)
      return
    }
    const duration = CURSE_DURATION[kind]
    if (duration <= 0) return
    for (let i = 0; i < state.activeCurses.length; i++) {
      if (state.activeCurses[i].kind === kind) {
        state.activeCurses[i].remaining = duration
        return
      }
    }
    state.activeCurses.push({ kind, remaining: duration })
  }

  function serialize(): SaveGame {
    return {
      version: 1,
      grid: gridToFlat(state.grid),
      current: clonePiece(state.current),
      next: clonePiece(state.next),
      bag: bag.slice(),
      bagRngState: bagRng.getState(),
      miscRngState: miscRng.getState(),
      aimAngle: state.aimAngle,
      score: state.score,
      level: state.level,
      clearsTotal: state.clearsTotal,
      combo: state.combo,
      elapsed: state.elapsed,
      riseTimer: state.riseTimer,
      riseInterval: state.riseInterval,
    }
  }

  return {
    state,
    events: bus,
    update,
    setAim,
    aimBy,
    rotate,
    launch,
    useCurse,
    applyCurse,
    addGarbage,
    serialize,
  }
}

// ---------------------------------------------------------------------------
// Aim preview
// ---------------------------------------------------------------------------

const aimScratch = makeScratch()
const aimMover: Mover = {
  piece: { kind: 'I', rot: 0, colors: [0, 0, 1, 1] },
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
}

/**
 * The trajectory the current piece would follow: launcher, wall bounces, and
 * the pivot where it would come to rest. Shares its kinematics with the engine,
 * so the preview never lies.
 */
export function computeAimPath(state: GameState, maxPoints = 24): AimPoint[] {
  const points: AimPoint[] = [{ x: LAUNCH_X, y: LAUNCH_Y }]
  const bounceLimit = Math.max(1, maxPoints - 1)

  const m = aimMover
  m.piece = state.current
  m.x = LAUNCH_X
  m.y = LAUNCH_Y
  m.vx = Math.sin(state.aimAngle) * LAUNCH_SPEED
  m.vy = Math.cos(state.aimAngle) * LAUNCH_SPEED

  const dt = MAX_SUBSTEP_CELLS / LAUNCH_SPEED
  const addBounce = (x: number, y: number): void => {
    if (points.length < bounceLimit) points.push({ x, y })
  }

  let hit = false
  for (let i = 0; i < AIM_MAX_STEPS; i++) {
    if (stepMover(state.grid, m, dt, aimScratch, addBounce)) {
      hit = true
      break
    }
  }

  if (hit) {
    findLockPlacement(state.grid, m.piece, m.x, m.y, m.vx, m.vy, aimScratch)
    points.push({ x: PLACE.x, y: settle(state.grid, m.piece, PLACE.x, PLACE.y, aimScratch) })
  } else {
    points.push({ x: m.x, y: m.y })
  }
  return points
}
