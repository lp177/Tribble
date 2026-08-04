// Versus controller: bridges the local Game and a NetSession.
// Outgoing: throttled board snapshots, curses, game over. Incoming: opponent
// snapshots, curses applied to the local game, and the rematch handshake.
// Nothing that happens on the wire is trusted: malformed messages are dropped
// and no handler is ever allowed to throw back into the network layer.

import { COLS, CURSE_KINDS, ROWS } from '../types'
import type {
  Cell,
  CurseKind,
  Game,
  Grid,
  NetMsg,
  NetSession,
  OpponentView,
  VersusController,
  VersusHooks,
} from '../types'

/** Snapshot rate: 5 Hz. */
const STATE_INTERVAL = 0.2
const CELL_COUNT = ROWS * COLS

function toCell(v: unknown): Cell {
  if (v === 0) return 0
  if (v === 1) return 1
  if (v === 2) return 2
  if (v === 3) return 3
  return null
}

function isCurseKind(v: unknown): v is CurseKind {
  return typeof v === 'string' && (CURSE_KINDS as readonly string[]).includes(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function emptyOpponentGrid(): Grid {
  const grid: Grid = new Array<Cell[]>(ROWS)
  for (let r = 0; r < ROWS; r++) grid[r] = new Array<Cell>(COLS).fill(null)
  return grid
}

export function createVersus(
  game: Game,
  session: NetSession,
  hooks: VersusHooks,
): VersusController {
  let current = game
  const gameSubs: Array<() => void> = []

  let acc = 0
  let ended = false
  let disposed = false
  /** The peer is gone for good: no more traffic, no rematch is ever possible. */
  let peerGone = false
  let localWant = false
  let remoteWant = false
  /** Reused so the renderer keeps a stable object between snapshots. */
  let lastView: OpponentView | null = null

  // Reused per-tick payload: flattened row-major grid, -1 = empty.
  const flat = new Array<number>(CELL_COUNT).fill(-1)
  const stateMsg = { t: 'state' as const, grid: flat, score: 0, danger: false }

  const safeSend = (msg: NetMsg): void => {
    if (disposed || peerGone) return
    try {
      session.send(msg)
    } catch (err) {
      console.error('versus: send failed', err)
    }
  }

  const fireEnd = (result: 'win' | 'lose' | 'disconnect'): void => {
    try {
      hooks.onEnd(result)
    } catch (err) {
      console.error('versus: onEnd hook failed', err)
    }
  }

  /** One end per match: the first result wins, later duplicates are dropped. */
  const end = (result: 'win' | 'lose' | 'disconnect'): void => {
    if (ended || disposed) return
    ended = true
    fireEnd(result)
  }

  /**
   * The session died. During a match that is simply the result; once the match
   * is over it is new information — the post-match screen is offering a rematch
   * that can never happen — so the UI hears about it either way, exactly once.
   */
  const handleClose = (): void => {
    if (disposed || peerGone) return
    peerGone = true
    // Nothing is pending any more: requestRematch() must not wait forever.
    localWant = false
    remoteWant = false
    ended = true
    fireEnd('disconnect')
  }

  const unsubscribeGame = (): void => {
    for (const off of gameSubs) off()
    gameSubs.length = 0
  }

  const subscribeGame = (g: Game): void => {
    gameSubs.push(
      g.events.on('gameOver', (p) => {
        safeSend({ t: 'gameOver', score: p.score })
        end('lose')
      }),
    )
  }

  const sendState = (): void => {
    const grid = current.state.grid
    let i = 0
    for (let r = 0; r < ROWS; r++) {
      const row = grid[r]
      for (let c = 0; c < COLS; c++) {
        const cell = row[c]
        flat[i++] = cell === null ? -1 : cell
      }
    }
    stateMsg.score = current.state.score
    stateMsg.danger = current.state.danger
    safeSend(stateMsg)
  }

  const handleState = (msg: { grid: number[]; score: number; danger: boolean }): void => {
    // Symmetric with update(): once the match is decided the last snapshot is
    // the one that matches the result, so late ones must not overwrite it.
    if (ended) return
    const incoming: unknown = msg.grid
    if (!Array.isArray(incoming) || incoming.length !== CELL_COUNT) return

    let view = lastView
    if (view === null) {
      view = {
        grid: emptyOpponentGrid(),
        score: 0,
        danger: false,
        name: session.peerName,
        gameOver: false,
      }
      lastView = view
    }

    const grid = view.grid
    let i = 0
    for (let r = 0; r < ROWS; r++) {
      const row = grid[r]
      for (let c = 0; c < COLS; c++) row[c] = toCell(incoming[i++])
    }
    if (isFiniteNumber(msg.score)) view.score = msg.score
    view.danger = msg.danger === true
    view.gameOver = false
    hooks.onOpponentUpdate(view)
  }

  const startRematch = (seed: number): void => {
    localWant = false
    remoteWant = false
    ended = false
    acc = 0
    // The previous match's board must not be shown as this match's opponent.
    lastView = null
    try {
      hooks.onRematch(seed)
    } catch (err) {
      console.error('versus: onRematch hook failed', err)
    }
  }

  /** The host owns the seed, so only it closes the handshake. */
  const maybeAcceptRematch = (): void => {
    if (peerGone || !localWant || !remoteWant || session.role !== 'host') return
    const seed = (Math.random() * 0x7fffffff) | 0
    safeSend({ t: 'rematchAccept', seed })
    startRematch(seed)
  }

  const unsubMsg = session.onMessage((msg) => {
    if (disposed || peerGone) return
    try {
      if (msg === null || typeof msg !== 'object') return
      switch (msg.t) {
        case 'state':
          handleState(msg)
          break
        case 'curse':
          // A curse only means anything while this match is actually running.
          if (ended || current.state.phase === 'gameover') return
          if (!isCurseKind(msg.kind)) return
          current.applyCurse(msg.kind)
          hooks.onCurseIncoming(msg.kind)
          break
        case 'gameOver':
          if (lastView !== null) {
            if (isFiniteNumber(msg.score)) lastView.score = msg.score
            lastView.gameOver = true
            hooks.onOpponentUpdate(lastView)
          }
          end('win')
          break
        case 'rematchRequest':
          remoteWant = true
          maybeAcceptRematch()
          break
        case 'rematchAccept':
          // Only the guest takes a seed, and only for a rematch it asked for.
          if (session.role !== 'guest' || !localWant) return
          if (!isFiniteNumber(msg.seed)) return
          startRematch(msg.seed)
          break
        default:
          break
      }
    } catch (err) {
      console.error('versus: message handling failed', err)
    }
  })

  session.onClose(handleClose)

  subscribeGame(current)

  return {
    update(dt: number): void {
      // Once the match is decided both sides stop broadcasting, so the final
      // snapshot stays the one that matches the result.
      if (disposed || peerGone || ended) return
      acc += dt
      if (acc < STATE_INTERVAL) return
      acc = acc >= STATE_INTERVAL * 2 ? 0 : acc - STATE_INTERVAL
      sendState()
    },

    sendCurse(kind: CurseKind): void {
      if (ended) return
      safeSend({ t: 'curse', kind })
    },

    requestRematch(): void {
      // With the peer gone there is nobody left to agree, so never start waiting.
      if (disposed || peerGone || localWant) return
      localWant = true
      safeSend({ t: 'rematchRequest' })
      maybeAcceptRematch()
    },

    setGame(newGame: Game): void {
      if (disposed) return
      unsubscribeGame()
      current = newGame
      acc = 0
      subscribeGame(newGame)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      unsubscribeGame()
      unsubMsg()
    },
  }
}
