// P2P session establishment over the public PeerJS broker.
// Host claims the id `tribble-<CODE>`; guest connects to it. Both sides
// exchange a `hello` message before the session promise resolves.

import { Peer } from 'peerjs'
import type { DataConnection, PeerError } from 'peerjs'
import { NET_PROTOCOL_VERSION } from '../types'
import type { CancellablePromise, NetMsg, NetSession } from '../types'

/** No lookalikes: excludes I, O, 0, 1. */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 5
const MAX_CODE_TRIES = 3
const CONNECT_TIMEOUT_MS = 30_000
const PEER_ID_PREFIX = 'tribble-'

const ERROR_MESSAGES: Record<string, string> = {
  'peer-unavailable': 'Room not found',
  'unavailable-id': 'Room code already taken, try again',
  'invalid-id': 'Invalid room code',
  'browser-incompatible': 'This browser does not support WebRTC',
  network: 'Cannot reach the matchmaking server',
  'server-error': 'Matchmaking server error',
  'socket-error': 'Lost connection to the matchmaking server',
  'socket-closed': 'Lost connection to the matchmaking server',
  disconnected: 'Disconnected from the matchmaking server',
  webrtc: 'Peer-to-peer connection failed',
}

function friendlyError(err: PeerError<string>): Error {
  return new Error(ERROR_MESSAGES[err.type] ?? err.message ?? 'Connection failed')
}

function randomCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

interface AttemptCtx {
  setPeer(p: Peer): void
  succeed(session: NetSession): void
  fail(err: Error): void
  isSettled(): boolean
}

/**
 * Shared promise plumbing: overall timeout, cancel() that destroys the
 * current peer, settle-once guarantees.
 */
function cancellableSession(run: (ctx: AttemptCtx) => void): CancellablePromise<NetSession> {
  let peer: Peer | null = null
  let settled = false
  let resolveFn!: (s: NetSession) => void
  let rejectFn!: (e: Error) => void
  const promise = new Promise<NetSession>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })

  const fail = (err: Error): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    const p = peer
    peer = null
    p?.destroy()
    rejectFn(err)
  }
  const succeed = (session: NetSession): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolveFn(session)
  }

  const timer = setTimeout(() => fail(new Error('timeout')), CONNECT_TIMEOUT_MS)

  run({
    setPeer: (p) => {
      peer = p
    },
    succeed,
    fail,
    isSettled: () => settled,
  })

  const cancellable = promise as CancellablePromise<NetSession>
  cancellable.cancel = () => fail(new Error('cancelled'))
  return cancellable
}

/**
 * Send our hello once the connection opens and resolve the session when the
 * remote hello arrives. Any close/error before that rejects the attempt.
 */
function exchangeHello(
  peer: Peer,
  conn: DataConnection,
  role: 'host' | 'guest',
  name: string,
  succeed: (s: NetSession) => void,
  fail: (e: Error) => void,
): void {
  let helloSent = false
  const sendHello = (): void => {
    if (helloSent) return
    helloSent = true
    const hello: NetMsg = { t: 'hello', name, version: NET_PROTOCOL_VERSION }
    void conn.send(hello)
  }

  const onData = (data: unknown): void => {
    if (typeof data !== 'object' || data === null) return
    const msg = data as { t?: unknown; name?: unknown; version?: unknown }
    if (msg.t !== 'hello') return
    conn.off('data', onData)
    if (msg.version !== NET_PROTOCOL_VERSION || typeof msg.name !== 'string') {
      conn.close()
      fail(new Error('Game version mismatch — both players need the same version of Tribble'))
      return
    }
    succeed(createSession(peer, conn, role, msg.name))
  }

  conn.on('data', onData)
  conn.on('open', sendHello)
  if (conn.open) sendHello()
  conn.on('close', () => fail(new Error('Connection closed during setup')))
  conn.on('error', (err) => fail(friendlyError(err)))
}

function createSession(
  peer: Peer,
  conn: DataConnection,
  role: 'host' | 'guest',
  peerName: string,
): NetSession {
  const messageSubs = new Set<(msg: NetMsg) => void>()
  const closeSubs: Array<() => void> = []
  let closed = false

  const fireClose = (): void => {
    if (closed) return
    closed = true
    for (const fn of closeSubs) fn()
  }

  conn.on('data', (data: unknown) => {
    if (closed || typeof data !== 'object' || data === null) return
    if (typeof (data as { t?: unknown }).t !== 'string') return
    const msg = data as NetMsg
    for (const fn of messageSubs) fn(msg)
  })
  conn.on('close', fireClose)
  conn.on('error', fireClose)
  peer.on('error', fireClose)
  peer.on('disconnected', fireClose)
  peer.on('close', fireClose)

  return {
    role,
    peerName,
    send(msg: NetMsg): void {
      if (closed || !conn.open) return
      void conn.send(msg)
    },
    onMessage(fn: (msg: NetMsg) => void): () => void {
      messageSubs.add(fn)
      return () => messageSubs.delete(fn)
    },
    onClose(fn: () => void): void {
      closeSubs.push(fn)
    },
    close(): void {
      // Deliberate local close: suppress onClose, then tear everything down.
      closed = true
      peer.destroy()
    },
  }
}

export function hostSession(
  name: string,
  onCode: (code: string) => void,
): CancellablePromise<NetSession> {
  return cancellableSession(({ setPeer, succeed, fail, isSettled }) => {
    let tries = 0
    let claimed: DataConnection | null = null

    const attempt = (): void => {
      tries += 1
      const code = randomCode()
      const peer = new Peer(PEER_ID_PREFIX + code)
      setPeer(peer)

      peer.on('open', () => {
        if (!isSettled()) onCode(code)
      })
      peer.on('error', (err) => {
        if (isSettled()) return
        if (err.type === 'unavailable-id' && tries < MAX_CODE_TRIES) {
          peer.destroy()
          attempt()
          return
        }
        fail(friendlyError(err))
      })
      peer.on('connection', (conn) => {
        // Serialization is whatever the guest negotiated (json).
        if (isSettled() || claimed !== null) {
          if (conn.open) conn.close()
          else conn.on('open', () => conn.close())
          return
        }
        claimed = conn
        exchangeHello(peer, conn, 'host', name, succeed, fail)
      })
    }

    attempt()
  })
}

export function joinSession(code: string, name: string): CancellablePromise<NetSession> {
  return cancellableSession(({ setPeer, succeed, fail, isSettled }) => {
    const normalized = normalizeCode(code)
    if (normalized.length !== CODE_LENGTH) {
      fail(new Error('Invalid room code'))
      return
    }

    const peer = new Peer()
    setPeer(peer)

    peer.on('error', (err) => {
      if (!isSettled()) fail(friendlyError(err))
    })
    peer.on('open', () => {
      if (isSettled()) return
      const conn = peer.connect(PEER_ID_PREFIX + normalized, {
        reliable: true,
        serialization: 'json',
      })
      exchangeHello(peer, conn, 'guest', name, succeed, fail)
    })
  })
}
