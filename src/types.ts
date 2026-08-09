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

/** The 7 tetrominoes, then the 5 pentominoes the `giant` hazard draws from. */
export type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L' | 'P' | 'U' | 'W' | 'F' | 'Y'
export type Rotation = 0 | 1 | 2 | 3
/** Largest cell count of any piece; sizes the reusable cell buffers. */
export const MAX_PIECE_CELLS = 5

/** Integer cell offset from the piece pivot (cell units). */
export interface CellOffset {
  x: number
  y: number
}

export interface Piece {
  kind: PieceKind
  rot: Rotation
  /** colors[i] colors the i-th cell of the shape; same length as the shape. */
  colors: readonly CellColor[]
  /** Armour the piece's blocks land with (0 = normal). */
  armor?: number
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

// Shape data lives here (not in core) so render/ui can draw pieces without
// importing core. Cell order is stable across rotations: colors[i] always
// colors cell i. Cells 0,1 are orthogonally adjacent and cells 2,3 are
// adjacent (diagonal for T), so a piece never self-matches 3 of a color.
const BASE_SHAPES: Record<PieceKind, CellOffset[]> = {
  I: [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
  O: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  T: [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
  S: [{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 1 }],
  Z: [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  J: [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
  L: [{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: 1 }],
  // Pentominoes — only the `giant` hazard deals these.
  P: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 }],
  U: [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  W: [{ x: -1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
  F: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 2 }],
  Y: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }],
}

function buildRotations(base: CellOffset[]): CellOffset[][] {
  const rots: CellOffset[][] = [base]
  for (let r = 1; r < 4; r++) {
    rots.push(rots[r - 1].map((c) => ({ x: -c.y, y: c.x })))
  }
  return rots
}

/** The normal bag. */
export const PIECE_KINDS: readonly PieceKind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']
/** Dealt only while the `giant` hazard is running. */
export const BIG_PIECE_KINDS: readonly PieceKind[] = ['P', 'U', 'W', 'F', 'Y']

/** SHAPES[kind][rot] -> 4 cell offsets from the pivot. */
export const SHAPES: Record<PieceKind, ReadonlyArray<ReadonlyArray<CellOffset>>> = {
  I: buildRotations(BASE_SHAPES.I),
  O: buildRotations(BASE_SHAPES.O),
  T: buildRotations(BASE_SHAPES.T),
  S: buildRotations(BASE_SHAPES.S),
  Z: buildRotations(BASE_SHAPES.Z),
  J: buildRotations(BASE_SHAPES.J),
  L: buildRotations(BASE_SHAPES.L),
  P: buildRotations(BASE_SHAPES.P),
  U: buildRotations(BASE_SHAPES.U),
  W: buildRotations(BASE_SHAPES.W),
  F: buildRotations(BASE_SHAPES.F),
  Y: buildRotations(BASE_SHAPES.Y),
}

export function pieceOffsets(piece: Piece): ReadonlyArray<CellOffset> {
  return SHAPES[piece.kind][piece.rot]
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
export const RISE_WARNING_AT = 1.5
export const CHAIN_MULT_CAP = 32

// Legacy defaults — these are the 'normal' tier's values, kept as named
// constants because saves and tests refer to them. New code should read the
// active DifficultyConfig instead.
export const INITIAL_ROWS = 4
export const RISE_START = 10
export const RISE_MIN = 3.2
export const RISE_TAU = 150
export const CLEARS_PER_LEVEL = 7

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export type Difficulty = 'chill' | 'normal' | 'hard' | 'hardcore'

export interface DifficultyConfig {
  id: Difficulty
  label: string
  blurb: string
  /** Seconds between rises at the start of a run. */
  riseStart: number
  /** Floor the rise interval decays towards. */
  riseMin: number
  /** Decay time constant, seconds. Smaller = the squeeze arrives sooner. */
  riseTau: number
  /** Extra multiplier applied to the rise interval per level above 1. */
  riseLevelFactor: number
  initialRows: number
  clearsPerLevel: number
  /** Seconds between random hazards; 0 disables them entirely. */
  hazardEvery: number
  /** Colour matching is permanently off — every block reads as stone. */
  stoneOnly: boolean
  /** Whether the aim guide is drawn at all. */
  aimGuide: boolean
  /** Chance a locked piece lands armoured, outside the `armor` hazard. */
  armorChance: number
  /** Score multiplier, so the harder tiers are worth playing. */
  scoreScale: number
}

export const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  chill: {
    id: 'chill',
    label: 'Chill',
    blurb: 'Room to breathe. No hazards, gentle rise.',
    riseStart: 16,
    riseMin: 6,
    riseTau: 260,
    riseLevelFactor: 0.99,
    initialRows: 3,
    clearsPerLevel: 10,
    hazardEvery: 0,
    stoneOnly: false,
    aimGuide: true,
    armorChance: 0,
    scoreScale: 0.7,
  },
  normal: {
    id: 'normal',
    label: 'Normal',
    blurb: 'Steady squeeze with the occasional hazard.',
    riseStart: 10,
    riseMin: 3.2,
    riseTau: 150,
    riseLevelFactor: 0.965,
    initialRows: 4,
    clearsPerLevel: 7,
    hazardEvery: 45,
    stoneOnly: false,
    aimGuide: true,
    armorChance: 0.06,
    scoreScale: 1,
  },
  hard: {
    id: 'hard',
    label: 'Hard',
    blurb: 'Fast rise, frequent hazards, armoured blocks.',
    riseStart: 7,
    riseMin: 2.2,
    riseTau: 100,
    riseLevelFactor: 0.95,
    initialRows: 5,
    clearsPerLevel: 6,
    hazardEvery: 30,
    stoneOnly: false,
    aimGuide: true,
    armorChance: 0.12,
    scoreScale: 1.5,
  },
  hardcore: {
    id: 'hardcore',
    label: 'Hardcore',
    blurb: 'Stone only — no colour matches, no aim guide. Lines are all you get.',
    riseStart: 5.5,
    riseMin: 1.8,
    riseTau: 80,
    riseLevelFactor: 0.94,
    initialRows: 6,
    clearsPerLevel: 5,
    hazardEvery: 24,
    stoneOnly: true,
    aimGuide: false,
    armorChance: 0.18,
    scoreScale: 2.5,
  },
}

export const DIFFICULTY_ORDER: readonly Difficulty[] = ['chill', 'normal', 'hard', 'hardcore']

// ---------------------------------------------------------------------------
// Hazards (random solo events)
// ---------------------------------------------------------------------------

/**
 * `stone`  — every block reads as colourless: only line clears work.
 * `armor`  — pieces land armoured and need an extra break.
 * `giant`  — pentominoes instead of tetrominoes.
 * `rush`   — the stack rises twice as fast.
 */
export type HazardKind = 'stone' | 'armor' | 'giant' | 'rush'

export const HAZARD_KINDS: readonly HazardKind[] = ['stone', 'armor', 'giant', 'rush']

export const HAZARD_DURATION: Record<HazardKind, number> = {
  stone: 14,
  armor: 18,
  giant: 20,
  rush: 12,
}

export const HAZARD_LABEL: Record<HazardKind, string> = {
  stone: 'Stonefall — colours are dead, clear lines!',
  armor: 'Reinforced — blocks need two breaks',
  giant: 'Giants — oversized pieces incoming',
  rush: 'Rush — the stack is climbing fast',
}

export interface ActiveHazard {
  kind: HazardKind
  remaining: number
}

/** Armour a block lands with when the `armor` hazard is running. */
export const HAZARD_ARMOR = 1

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
  /** Parallel to `grid`: remaining extra breaks per cell, 0 for a normal block. */
  armor: number[][]
  difficulty: Difficulty
  hazards: ActiveHazard[]
  /** True while colour matching is off (hardcore, or a `stone` hazard). */
  colorsLocked: boolean
  /** Seconds until the next hazard rolls; Infinity when hazards are disabled. */
  hazardTimer: number
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
  /** Defaults to 'normal'. */
  difficulty?: Difficulty
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
  hazardStart: { kind: HazardKind }
  hazardEnd: { kind: HazardKind }
  /** An armoured block absorbed a clear instead of breaking. */
  armorHit: { row: number; col: number; remaining: number }
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
  version: 2
  difficulty: Difficulty
  /** Flat, row-major, parallel to `grid`. */
  armor: number[]
  hazards: ActiveHazard[]
  hazardTimer: number
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
  difficulty: Difficulty
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  bindings: DEFAULT_BINDINGS,
  masterVolume: 0.8,
  sfxVolume: 1,
  musicVolume: 0.6,
  reducedMotion: 'auto',
  playerName: 'Player',
  difficulty: 'normal',
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

/**
 * A moment dramatic enough to take the music over until it passes. Pushed and
 * popped by id so the score returns to normal when the moment does.
 */
export type MusicEvent = 'curse' | 'power' | 'danger' | 'surge'

export interface AudioEngine {
  /** Safe to call anytime; silently no-ops before resume(). */
  play(name: SfxName, opts?: { pitch?: number; volume?: number }): void
  /** Starts a randomly chosen track, so runs don't all sound the same. */
  startMusic(): void
  stopMusic(): void
  /** Cross-fade to a different randomly chosen base track. */
  shuffleMusic(): void
  /**
   * Take the music over for a named event. The id must be unique while active;
   * pushing the same id again just refreshes it.
   */
  pushMusicEvent(id: string, kind: MusicEvent): void
  /** End that event; the score returns to a re-rolled base track. */
  popMusicEvent(id: string): void
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

/** Colour index the renderer paints blocks with while colours are locked. */
export const STONE_HEX = '#7b8394'

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
  /** Start a match against the AI instead of a person. */
  onPlayBot(level: BotLevel): void
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

// ---------------------------------------------------------------------------
// AI opponent
// ---------------------------------------------------------------------------

export type BotLevel = 'rookie' | 'skilled' | 'merciless'

export interface BotLevelConfig {
  id: BotLevel
  label: string
  blurb: string
  /** Candidate aim angles evaluated per turn; more = better play, more cost. */
  angleSteps: number
  /** Seconds the bot "thinks" before firing, so it does not feel robotic. */
  thinkMin: number
  thinkMax: number
  /**
   * Random jitter added to each candidate's score, as a fraction of the score
   * spread. This is how a weaker bot misplays: it genuinely picks worse moves
   * rather than being handicapped after the fact.
   */
  noise: number
  /** Chance per turn of skipping the search entirely and firing roughly. */
  blunderChance: number
  /** Seconds it sits on a caught curse before sending it. */
  curseDelay: number
  /** Weight on steering the shot through a power bubble. */
  powerAppetite: number
}

export const BOT_LEVELS: Record<BotLevel, BotLevelConfig> = {
  rookie: {
    id: 'rookie',
    label: 'Rookie',
    blurb: 'Still learning the angles. Misses a lot.',
    angleSteps: 9,
    thinkMin: 0.9,
    thinkMax: 1.8,
    noise: 0.55,
    blunderChance: 0.22,
    curseDelay: 3.5,
    powerAppetite: 0.2,
  },
  skilled: {
    id: 'skilled',
    label: 'Skilled',
    blurb: 'Plays a tidy board and will punish a sloppy stack.',
    angleSteps: 17,
    thinkMin: 0.55,
    thinkMax: 1.1,
    noise: 0.18,
    blunderChance: 0.06,
    curseDelay: 1.6,
    powerAppetite: 0.8,
  },
  merciless: {
    id: 'merciless',
    label: 'Merciless',
    blurb: 'Hunts power bubbles and curses you the moment it can.',
    angleSteps: 25,
    thinkMin: 0.3,
    thinkMax: 0.6,
    noise: 0,
    blunderChance: 0,
    curseDelay: 0.4,
    powerAppetite: 1.4,
  },
}

export const BOT_LEVEL_ORDER: readonly BotLevel[] = ['rookie', 'skilled', 'merciless']

/** A move the AI has decided on: where to aim, and how the piece should sit. */
export interface BotMove {
  /** Radians, already clamped to +/- MAX_AIM_ANGLE. */
  angle: number
  /** Absolute rotation the piece should be in when it launches. */
  rot: Rotation
  /** The evaluated score, for tests and debugging. */
  score: number
}

/**
 * An opponent that is not a person. It satisfies NetSession, so the whole
 * versus stack — curses, the opponent mini-board, the rematch handshake —
 * works against it unchanged.
 */
export interface BotSession {
  readonly session: NetSession
  /** Drive the bot's own game. Called from the main loop. */
  update(dt: number): void
  dispose(): void
}

export interface BotOptions {
  seed: number
  level: BotLevel
  difficulty: Difficulty
}

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
