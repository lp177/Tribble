// Tribble — shared types, constants and cross-module interfaces.
// This file is the single source of truth for everything that crosses a module
// boundary. See DESIGN.md ("Module contracts") for which module implements what.
// It must have NO imports and NO side effects.

// ---------------------------------------------------------------------------
// Board & pieces
// ---------------------------------------------------------------------------

export const COLS = 11
export const ROWS = 20
/** Rows [0, TOP_KILL_ROW) are the launcher zone; a settled cell there = game over. */
export const TOP_KILL_ROW = 3
/** Stack within this many rows of the kill zone => danger state. */
export const DANGER_ROWS = 4

export const LAUNCH_X = COLS / 2
export const LAUNCH_Y = 1.0
/** Max aim deviation from straight down, radians (~70°). */
export const MAX_AIM_ANGLE = 1.22
/** Flying piece speed, cells per second. */
export const LAUNCH_SPEED = 26
/** Keyboard aim sweep speed, radians per second. */
export const AIM_KEY_SPEED = 1.6

export const COLOR_COUNT = 4
export type CellColor = 0 | 1 | 2 | 3
/** A grid cell: a color, or empty. */
export type Cell = CellColor | null
/** grid[row][col], row 0 at the top. Dimensions always ROWS x COLS. */
export type Grid = Cell[][]

export type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L'
export type Rotation = 0 | 1 | 2 | 3

/** Integer cell offset from the piece pivot (cell units). */
export interface CellOffset {
  x: number
  y: number
}

export interface Piece {
  kind: PieceKind
  rot: Rotation
  /** colors[i] colors the i-th cell of the shape in every rotation. */
  colors: [CellColor, CellColor, CellColor, CellColor]
}

/** A piece cell resolved to a concrete grid cell. */
export interface PlacedCell {
  row: number
  col: number
  color: CellColor
}

export interface Match {
  color: CellColor
  cells: Array<{ row: number; col: number }>
}

export interface AimPoint {
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// RNG (serializable, deterministic)
// ---------------------------------------------------------------------------

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  /** Uniform integer in [0, n). */
  int(n: number): number
  pick<T>(arr: readonly T[]): T
  getState(): number
  setState(s: number): void
}

// ---------------------------------------------------------------------------
// Rules & tuning constants
// ---------------------------------------------------------------------------

export const MATCH_MIN = 3
export const RESOLVE_STEP = 0.22
export const INITIAL_ROWS = 4
export const RISE_START = 14
export const RISE_MIN = 4.5
export const RISE_TAU = 240
export const RISE_WARNING_AT = 1.5
export const CHAIN_MULT_CAP = 32
export const CLEARS_PER_LEVEL = 8

export const MAX_POWERS = 3
export const MAX_INVENTORY = 3
export const POWER_RADIUS = 0.6
export const POWER_RISE_SPEED = 1.2

// ---------------------------------------------------------------------------
// Versus / curses
// ---------------------------------------------------------------------------

export type CurseKind = 'garbage' | 'speed' | 'fog' | 'scramble' | 'mirror' | 'lockRotate'

export const CURSE_KINDS: readonly CurseKind[] = [
  'garbage',
  'speed',
  'fog',
  'scramble',
  'mirror',
  'lockRotate',
]

export const CURSE_DURATION: Record<CurseKind, number> = {
  garbage: 0,
  speed: 15,
  fog: 12,
  scramble: 0,
  mirror: 10,
  lockRotate: 10,
}

export interface ActiveCurse {
  kind: CurseKind
  remaining: number
}

export interface PowerBubble {
  id: number
  kind: CurseKind
  /** Cell units. */
  x: number
  y: number
  age: number
}

// ---------------------------------------------------------------------------
// Game state & engine
// ---------------------------------------------------------------------------

export type GamePhase = 'aiming' | 'flying' | 'resolving' | 'gameover'

export interface FlyingPiece {
  piece: Piece
  /** Pivot position, cell units. */
  x: number
  y: number
  /** Velocity, cells per second. */
  vx: number
  vy: number
}

export interface GameState {
  grid: Grid
  phase: GamePhase
  current: Piece
  next: Piece
  flying: FlyingPiece | null
  /** Radians; 0 = straight down, positive = towards +x (right). */
  aimAngle: number
  score: number
  level: number
  clearsTotal: number
  /** Current cascade depth while resolving (0 outside cascades). */
  chain: number
  /** Consecutive launches that cleared something. */
  combo: number
  /** Seconds of active play (excludes pause). */
  elapsed: number
  riseTimer: number
  riseInterval: number
  danger: boolean
  versus: boolean
  powers: PowerBubble[]
  inventory: CurseKind[]
  activeCurses: ActiveCurse[]
}

export interface GameOptions {
  seed: number
  versus?: boolean
}

// -- Events -----------------------------------------------------------------

export interface ClearInfo {
  /** Row indices cleared as full lines this step. */
  lines: number[]
  matches: Match[]
  chain: number
  /** Score awarded for this step. */
  score: number
  /** Centroid of all cleared cells, cell units. */
  cx: number
  cy: number
}

export interface GameEvents {
  launch: { angle: number }
  rotate: { dir: 1 | -1 }
  bounce: { x: number; y: number }
  impact: { x: number; y: number; speed: number }
  lock: { cells: PlacedCell[] }
  clear: ClearInfo
  chainStep: { chain: number }
  fall: Record<string, never>
  rise: { rows: number }
  riseWarning: Record<string, never>
  danger: { on: boolean }
  levelUp: { level: number }
  score: { delta: number; cx: number; cy: number }
  gameOver: { score: number }
  powerSpawn: { power: PowerBubble }
  powerCaught: { kind: CurseKind }
  powerLost: { id: number }
  curseApplied: { kind: CurseKind }
  curseExpired: { kind: CurseKind }
}

export type GameEventName = keyof GameEvents

export interface EventBus {
  on<K extends GameEventName>(name: K, fn: (payload: GameEvents[K]) => void): () => void
  off<K extends GameEventName>(name: K, fn: (payload: GameEvents[K]) => void): void
  emit<K extends GameEventName>(name: K, payload: GameEvents[K]): void
  /** Remove all listeners. */
  clear(): void
}

// -- Engine -----------------------------------------------------------------

export interface Game {
  readonly state: GameState
  readonly events: EventBus
  /** Advance the simulation. dt in seconds, already time-scaled by the caller. */
  update(dt: number): void
  setAim(angle: number): void
  aimBy(delta: number): void
  rotate(dir: 1 | -1): void
  launch(): void
  /** Pop the oldest stored curse; caller forwards it to the opponent. */
  useCurse(): CurseKind | null
  /** A curse arrives from the opponent and afflicts THIS game. */
  applyCurse(kind: CurseKind): void
  addGarbage(rows: number): void
  serialize(): SaveGame
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface SaveGame {
  version: 1
  grid: Array<number>
  current: Piece
  next: Piece
  bag: PieceKind[]
  bagRngState: number
  miscRngState: number
  aimAngle: number
  score: number
  level: number
  clearsTotal: number
  combo: number
  elapsed: number
  riseTimer: number
  riseInterval: number
}

export type GameAction =
  | 'aimLeft'
  | 'aimRight'
  | 'rotateCW'
  | 'rotateCCW'
  | 'launch'
  | 'useCurse'
  | 'pause'

export type KeyBindings = Record<GameAction, string[]>

export const DEFAULT_BINDINGS: KeyBindings = {
  aimLeft: ['ArrowLeft', 'KeyA'],
  aimRight: ['ArrowRight', 'KeyD'],
  rotateCW: ['ArrowUp', 'KeyX'],
  rotateCCW: ['KeyZ'],
  launch: ['Space'],
  useCurse: ['KeyC'],
  pause: ['Escape'],
}

export interface Settings {
  version: 1
  bindings: KeyBindings
  masterVolume: number
  sfxVolume: number
  musicVolume: number
  reducedMotion: 'auto' | 'on' | 'off'
  playerName: string
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  bindings: DEFAULT_BINDINGS,
  masterVolume: 0.8,
  sfxVolume: 1,
  musicVolume: 0.6,
  reducedMotion: 'auto',
  playerName: 'Player',
}

// ---------------------------------------------------------------------------
// FX
// ---------------------------------------------------------------------------

export interface Juice {
  shake(intensity: number, duration: number): void
  hitStop(duration: number): void
  flash(color: string, duration: number): void
  update(dt: number): void
  /** Pixel offsets + radians the renderer applies to the board transform. */
  readonly offsetX: number
  readonly offsetY: number
  readonly rotation: number
  /** 0 during hit-stop, else 1 (smoothed). Multiply the sim dt by this. */
  readonly timeScale: number
  readonly flashAlpha: number
  readonly flashColor: string
  setReducedMotion(on: boolean): void
}

export interface ParticleBurstOpts {
  count?: number
  speed?: number
  spread?: number
  gravity?: number
  life?: number
  size?: number
}

export interface ParticleSystem {
  /** Screen-space pixels. color is any CSS color. */
  burst(x: number, y: number, color: string, opts?: ParticleBurstOpts): void
  trail(x: number, y: number, color: string): void
  floatText(x: number, y: number, text: string, opts?: { color?: string; size?: number }): void
  update(dt: number): void
  render(ctx: CanvasRenderingContext2D): void
  clear(): void
  setReducedMotion(on: boolean): void
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export type SfxName =
  | 'launch'
  | 'bounce'
  | 'impact'
  | 'lock'
  | 'clearLine'
  | 'match'
  | 'chain'
  | 'rise'
  | 'riseWarning'
  | 'danger'
  | 'levelUp'
  | 'gameOver'
  | 'win'
  | 'click'
  | 'hover'
  | 'powerCatch'
  | 'curseSent'
  | 'curseHit'

export interface AudioEngine {
  /** Safe to call anytime; silently no-ops before resume(). */
  play(name: SfxName, opts?: { pitch?: number; volume?: number }): void
  startMusic(): void
  stopMusic(): void
  /** 0..1; drives music energy (tempo/brightness). */
  setIntensity(v: number): void
  setMasterVolume(v: number): void
  setSfxVolume(v: number): void
  setMusicVolume(v: number): void
  /** Create/resume the AudioContext. Call from a user gesture. */
  resume(): void
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface BoardMetrics {
  /** Top-left pixel of the board area (CSS pixels). */
  originX: number
  originY: number
  cellSize: number
  width: number
  height: number
}

export interface OpponentView {
  grid: Grid
  score: number
  danger: boolean
  name: string
  gameOver: boolean
}

export interface RenderOptions {
  /** null hides the aim line (e.g. while flying or fogged). */
  aimPath: AimPoint[] | null
  opponent: OpponentView | null
  fogged: boolean
  reducedMotion: boolean
}

export interface RendererDeps {
  canvas: HTMLCanvasElement
  juice: Juice
  particles: ParticleSystem
}

export interface Renderer {
  resize(): void
  render(state: GameState, opts: RenderOptions): void
  boardMetrics(): BoardMetrics
  /** Cell units -> CSS pixel coordinates on the canvas. */
  toScreen(x: number, y: number): { x: number; y: number }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InputManager {
  readonly bindings: KeyBindings
  setBindings(b: KeyBindings): void
  /** Poll continuous actions (aiming). */
  isDown(action: GameAction): boolean
  /** Discrete presses (rotate/launch/curse/pause). Returns unsubscribe. */
  onAction(fn: (action: GameAction) => void): () => void
  /** Pointer aim: cb receives canvas-relative CSS pixel coords on every move. */
  onPointerAim(fn: (px: number, py: number) => void): () => void
  /** Fires on primary click/tap on the canvas (launch). */
  onPointerLaunch(fn: () => void): () => void
  /** Fires on right/middle click (rotate). */
  onPointerRotate(fn: () => void): () => void
  /** Capture the next key press for rebinding; cb(null) when cancelled with Escape. */
  startRebind(cb: (code: string | null) => void): void
  destroy(): void
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export type Screen =
  | 'title'
  | 'settings'
  | 'howto'
  | 'versus-lobby'
  | 'paused'
  | 'gameover'
  | 'versus-end'

export interface MenuCallbacks {
  onNewGame(): void
  onResume(): void
  onOpenVersus(): void
  onHostGame(): void
  onJoinGame(code: string): void
  onCancelVersus(): void
  onSettingsChanged(s: Settings): void
  /** Ask input layer to capture a key; resolve with the code or null. */
  onRebindRequest(action: GameAction, done: (code: string | null) => void): void
  onPauseResume(): void
  onQuitToTitle(): void
  onRetry(): void
  onRematch(): void
  onUiSound(kind: 'click' | 'hover'): void
}

export interface GameOverData {
  score: number
  best: number
  level: number
}

export interface VersusEndData {
  result: 'win' | 'lose' | 'disconnect'
  score: number
}

export interface MenuApi {
  /** Shows a screen (hiding others). data: GameOverData | VersusEndData when relevant. */
  show(screen: Screen, data?: GameOverData | VersusEndData): void
  hideAll(): void
  readonly current: Screen | null
  setHasSave(has: boolean): void
  /** Lobby helpers. */
  setVersusStatus(text: string): void
  setVersusCode(code: string | null): void
  refreshSettings(s: Settings): void
}

export interface HudApi {
  update(state: GameState): void
  setOpponent(name: string | null, score: number): void
  setVisible(on: boolean): void
  /** Toast + aria-live announcement ("3× CHAIN!", "Curse incoming: Fog"). */
  announce(text: string, tone?: 'info' | 'good' | 'bad'): void
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

export const NET_PROTOCOL_VERSION = 1

export type NetMsg =
  | { t: 'hello'; name: string; version: number }
  | { t: 'start'; seed: number }
  | { t: 'state'; grid: number[]; score: number; danger: boolean }
  | { t: 'curse'; kind: CurseKind }
  | { t: 'gameOver'; score: number }
  | { t: 'rematchRequest' }
  | { t: 'rematchAccept'; seed: number }

export interface NetSession {
  readonly role: 'host' | 'guest'
  /** Opponent display name from the hello exchange. */
  readonly peerName: string
  send(msg: NetMsg): void
  onMessage(fn: (msg: NetMsg) => void): () => void
  onClose(fn: () => void): void
  close(): void
}

export type CancellablePromise<T> = Promise<T> & { cancel(): void }

export interface VersusHooks {
  onOpponentUpdate(view: OpponentView): void
  onCurseIncoming(kind: CurseKind): void
  onEnd(result: 'win' | 'lose' | 'disconnect'): void
  /** Both sides agreed on a rematch; seed for the fresh game. */
  onRematch(seed: number): void
}

export interface VersusController {
  update(dt: number): void
  sendCurse(kind: CurseKind): void
  requestRematch(): void
  /** Re-attach after a rematch created a fresh Game. */
  setGame(game: Game): void
  dispose(): void
}
