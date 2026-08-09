// The AI opponent, wearing a NetSession as a disguise.
//
// Versus already talks to the other player through NetSession, so the cheapest
// way to add a solo opponent is to make the bot answer to that interface: the
// versus controller, the curse exchange, the opponent mini-board and the rematch
// handshake all run unchanged against it. The bot keeps a real Game of its own,
// seeded identically to the human's, so both boards get the same piece sequence
// exactly like a two-peer match.
//
// Two rules keep the disguise from leaking:
//   * `role` is 'host'. The versus controller only closes a rematch when its
//     session reports 'host', so this puts the HUMAN in charge of the new seed
//     and leaves the bot following — the only arrangement where a rematch can
//     complete with nobody on the other end of the wire.
//   * Messages the bot produces are queued and delivered from `update()`, never
//     synchronously out of `send()`. A synchronous echo would re-enter the
//     versus controller in the middle of its own dispatch.

import { BOT_LEVELS, COLS, CURSE_KINDS, ROWS } from '../types'
import type {
  BotLevelConfig,
  BotOptions,
  BotSession,
  CurseKind,
  Game,
  NetMsg,
  NetSession,
} from '../types'
import { chooseMove } from '../ai/bot-brain'
import { createGame } from '../core/game'
import { createRng } from '../core/rng'

/** Snapshot rate: 5 Hz, the same cadence the real controller broadcasts at. */
const STATE_INTERVAL = 0.2
const CELL_COUNT = ROWS * COLS
/** Keeps the bot's decision stream out of phase with its own game's streams. */
const BOT_SEED_XOR = 0x5bf03635
/** A piece is never more than three clockwise turns from the wanted rotation. */
const MAX_ROTATE_STEPS = 3

function isCurseKind(v: unknown): v is CurseKind {
  return typeof v === 'string' && (CURSE_KINDS as readonly string[]).includes(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function createBotSession(opts: BotOptions): BotSession {
  const level: BotLevelConfig = BOT_LEVELS[opts.level] ?? BOT_LEVELS.skilled
  const rng = createRng((opts.seed ^ BOT_SEED_XOR) >>> 0)

  const listeners = new Set<(msg: NetMsg) => void>()

  // Two buffers swapped on flush, so delivering a batch never allocates and a
  // message queued by a listener simply lands in the next one.
  let outbox: NetMsg[] = []
  let spare: NetMsg[] = []
  let flushing = false
  /** The reused snapshot is in the queue; a second one would alias it. */
  let stateQueued = false

  let stopped = false
  /** The human topped out: the match is decided, so the bot stops playing. */
  let idle = false
  let gameOverSent = false

  let game: Game = createGame({ seed: opts.seed, versus: true, difficulty: opts.difficulty })
  let offGameOver = watchGameOver(game)

  /** Seconds left of the current turn's deliberation; `thinking` arms it once. */
  let thinkTimer = 0
  let thinking = false
  let curseTimer = level.curseDelay
  let stateAcc = 0

  // Reused per-snapshot payload: flattened row-major grid, -1 = empty.
  const flat = new Array<number>(CELL_COUNT).fill(-1)
  const stateMsg = { t: 'state' as const, grid: flat, score: 0, danger: false }

  function watchGameOver(g: Game): () => void {
    return g.events.on('gameOver', (p) => {
      if (gameOverSent) return
      gameOverSent = true
      enqueue({ t: 'gameOver', score: p.score })
    })
  }

  function enqueue(msg: NetMsg): void {
    if (stopped) return
    outbox.push(msg)
  }

  function queueState(): void {
    if (stopped || stateQueued) return
    const grid = game.state.grid
    let i = 0
    for (let r = 0; r < ROWS; r++) {
      const row = grid[r]
      for (let c = 0; c < COLS; c++) {
        const cell = row[c]
        flat[i++] = cell === null ? -1 : cell
      }
    }
    stateMsg.score = game.state.score
    stateMsg.danger = game.state.danger
    stateQueued = true
    outbox.push(stateMsg)
  }

  /** Hands the queued batch to the listeners. Never throws back into the loop. */
  function flush(): void {
    if (flushing || outbox.length === 0) return
    flushing = true
    const batch = outbox
    outbox = spare
    spare = batch
    stateQueued = false
    for (let i = 0; i < batch.length; i++) {
      for (const fn of listeners) {
        try {
          fn(batch[i])
        } catch (err) {
          console.error('bot: listener failed', err)
        }
      }
    }
    batch.length = 0
    flushing = false
  }

  /** A rematch was agreed: same bot, brand new game on the seed the human chose. */
  function restart(seed: number): void {
    offGameOver()
    game = createGame({ seed: seed >>> 0, versus: true, difficulty: opts.difficulty })
    offGameOver = watchGameOver(game)
    // Re-derived rather than continued, so replaying a seed replays the match.
    rng.setState((seed ^ BOT_SEED_XOR) >>> 0)
    idle = false
    gameOverSent = false
    thinking = false
    thinkTimer = 0
    curseTimer = level.curseDelay
    stateAcc = 0
  }

  function handleIncoming(msg: NetMsg): void {
    switch (msg.t) {
      case 'curse':
        if (!isCurseKind(msg.kind)) return
        game.applyCurse(msg.kind)
        break
      case 'gameOver':
        // The human lost. Playing on would keep pushing snapshots into a
        // controller that has already decided the match.
        idle = true
        break
      case 'rematchRequest':
        // The bot always agrees. Echoing the request is what sets `remoteWant`
        // on the human's side and lets its host half issue the seed.
        enqueue({ t: 'rematchRequest' })
        break
      case 'rematchAccept':
        if (!isFiniteNumber(msg.seed)) return
        restart(msg.seed)
        break
      default:
        // 'state' and 'hello' tell a bot nothing it does not already know.
        break
    }
  }

  /** Aim, orient and fire the move the brain settled on. */
  function playTurn(): void {
    const move = chooseMove(game.state, level, rng)
    // `rotate` is a no-op under the lockRotate curse, so the loop is bounded by
    // attempts rather than by reaching the target rotation.
    for (let i = 0; i < MAX_ROTATE_STEPS && game.state.current.rot !== move.rot; i++) {
      game.rotate(1)
    }
    game.setAim(move.angle)
    game.launch()
  }

  /**
   * A human takes a moment over each shot; instant fire reads as a machine and
   * makes the easier tiers impossible to keep up with. The move itself is chosen
   * once, when the timer runs out — searching every frame would only burn CPU to
   * arrive at the same answer.
   */
  function think(dt: number): void {
    if (game.state.phase !== 'aiming') {
      thinking = false
      return
    }
    if (!thinking) {
      thinking = true
      thinkTimer = level.thinkMin + rng.next() * Math.max(0, level.thinkMax - level.thinkMin)
    }
    thinkTimer -= dt
    if (thinkTimer > 0) return
    thinking = false
    playTurn()
  }

  /** Caught curses are held for a beat, so the bot does not fire them on sight. */
  function tickCurse(dt: number): void {
    if (game.state.inventory.length === 0) {
      curseTimer = level.curseDelay
      return
    }
    curseTimer -= dt
    if (curseTimer > 0) return
    curseTimer = level.curseDelay
    const kind = game.useCurse()
    if (kind !== null) enqueue({ t: 'curse', kind })
  }

  function tickState(dt: number): void {
    stateAcc += dt
    if (stateAcc < STATE_INTERVAL) return
    // A long stall (a backgrounded tab) resets rather than firing a burst.
    stateAcc = stateAcc >= STATE_INTERVAL * 2 ? 0 : stateAcc - STATE_INTERVAL
    queueState()
  }

  /** Indirection on purpose: keeps callers free of stale phase narrowing. */
  function isOver(): boolean {
    return game.state.phase === 'gameover'
  }

  function play(dt: number): void {
    if (idle || isOver()) return
    game.update(dt)
    // The last thing a dead game should do is announce it, which the gameOver
    // listener has already queued; no snapshot follows the obituary.
    if (isOver()) return
    think(dt)
    tickCurse(dt)
    tickState(dt)
  }

  function stop(): void {
    stopped = true
    outbox.length = 0
    spare.length = 0
    stateQueued = false
  }

  const session: NetSession = {
    role: 'host',
    peerName: `${level.label} AI`,

    send(msg: NetMsg): void {
      if (stopped) return
      try {
        if (msg === null || typeof msg !== 'object' || typeof msg.t !== 'string') return
        handleIncoming(msg)
      } catch (err) {
        console.error('bot: message handling failed', err)
      }
    },

    onMessage(fn: (msg: NetMsg) => void): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    onClose(_fn: () => void): void {
      // A bot never drops out. The only way this session ends is close()/
      // dispose(), which is a deliberate local teardown and must not reach the
      // controller as a disconnect.
    },

    close(): void {
      stop()
    },
  }

  return {
    session,

    update(dt: number): void {
      if (stopped) return
      if (dt > 0) play(dt)
      // Always flush, even once the bot is idle or dead: the final gameOver is
      // queued from inside the update that killed it.
      flush()
    },

    dispose(): void {
      stop()
      offGameOver()
      listeners.clear()
    },
  }
}
