// P2P session establishment over the public PeerJS broker.
// Host claims the id `tribble-<CODE>`; guest connects to it. Both sides
// exchange a `hello` message before the session promise resolves.

import { Peer } from 'peerjs'
import type { DataConnection, PeerError } from 'peerjs'
import { NET_PROTOCOL_VERSION } from '../types'
import type { CancellablePromise, NetMsg, NetSession } from '../types'
import { isRoomCode, normalizeCode, randomCode } from './invite'

const MAX_CODE_TRIES = 3
/** Getting connected, once there is someone on the other end to connect to. */
const CONNECT_TIMEOUT_MS = 30_000
/**
 * How long an open room waits for a friend. Sharing a link means pasting it
 * into a chat and waiting for someone to look at their phone, so this is
 * generous on purpose — the old 30s barely outlived the copy.
 */
const HOST_WAIT_MS = 10 * 60_000
const HOST_WAIT_MESSAGE = 'Nobody joined in time — host a new room'
const PEER_ID_PREFIX = 'tribble-'

/**
 * Peer-level errors that leave the peer permanently unusable. Everything else
 * (network/socket/server hiccups) only costs us the signalling server, which an
 * already-established DataConnection does not need — WebRTC data keeps flowing.
 */
const FATAL_PEER_ERRORS: ReadonlySet<string> = new Set([
  'browser-incompatible',
  'invalid-id',
  'invalid-key',
  'ssl-unavailable',
])

/** Bounded signalling reconnection so a flapping broker can't loop forever. */
const MAX_RECONNECT_TRIES = 5
const RECONNECT_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 8000

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

interface AttemptCtx {
  setPeer(p: Peer): void
  succeed(session: NetSession): void
  fail(err: Error): void
  isSettled(): boolean
  /** Restart the deadline; each phase of an attempt gets its own patience. */
  waitFor(ms: number, message: string): void
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

  let timer = setTimeout(() => fail(new Error('Connection timed out')), CONNECT_TIMEOUT_MS)
  const waitFor = (ms: number, message: string): void => {
    if (settled) return
    clearTimeout(timer)
    timer = setTimeout(() => fail(new Error(message)), ms)
  }

  run({
    setPeer: (p) => {
      peer = p
    },
    succeed,
    fail,
    isSettled: () => settled,
    waitFor,
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

  const onSetupClose = (): void => fail(new Error('Connection closed during setup'))
  const onSetupError = (err: PeerError<string>): void => fail(friendlyError(err))

  /** Setup is over: the session (or the caller) owns the connection from here. */
  const detachSetup = (): void => {
    conn.off('data', onData)
    conn.off('open', sendHello)
    conn.off('close', onSetupClose)
    conn.off('error', onSetupError)
  }

  const onData = (data: unknown): void => {
    if (typeof data !== 'object' || data === null) return
    const msg = data as { t?: unknown; name?: unknown; version?: unknown }
    if (msg.t !== 'hello') return
    detachSetup()
    if (msg.version !== NET_PROTOCOL_VERSION || typeof msg.name !== 'string') {
      // Detached first: closing here must not report a generic setup failure.
      conn.close()
      fail(new Error('Game version mismatch — both players need the same version of Tribble'))
      return
    }
    succeed(createSession(peer, conn, role, msg.name))
  }

  conn.on('data', onData)
  conn.on('open', sendHello)
  if (conn.open) sendHello()
  conn.on('close', onSetupClose)
  conn.on('error', onSetupError)
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
  let reconnectTries = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const onData = (data: unknown): void => {
    if (closed || typeof data !== 'object' || data === null) return
    if (typeof (data as { t?: unknown }).t !== 'string') return
    const msg = data as NetMsg
    for (const fn of messageSubs) fn(msg)
  }

  const detach = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    conn.off('data', onData)
    conn.off('close', onConnClose)
    conn.off('error', onConnError)
    peer.off('error', onPeerError)
    peer.off('disconnected', onPeerDisconnected)
    peer.off('close', onPeerClose)
  }

  const fireClose = (): void => {
    if (closed) return
    closed = true
    detach()
    for (const fn of closeSubs) fn()
  }

  function onConnClose(): void {
    fireClose()
  }
  function onConnError(): void {
    fireClose()
  }

  /**
   * Losing the broker does not touch a live DataConnection, so try to get the
   * signalling socket back instead of ending the match. Never fatal: if every
   * attempt fails we simply keep playing over the existing data channel.
   */
  function onPeerDisconnected(): void {
    if (closed || reconnectTimer !== null) return
    if (peer.destroyed || reconnectTries >= MAX_RECONNECT_TRIES) return
    reconnectTries += 1
    const delay = Math.min(
      RECONNECT_DELAY_MS * 2 ** (reconnectTries - 1),
      RECONNECT_MAX_DELAY_MS,
    )
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      // reconnect() throws on a destroyed peer or one that never disconnected.
      if (closed || peer.destroyed || !peer.disconnected) return
      try {
        peer.reconnect()
      } catch (err) {
        console.warn('p2p: signalling reconnect failed', err)
      }
    }, delay)
  }

  function onPeerError(err: PeerError<string>): void {
    // The connection is the source of truth now; only a peer that can never
    // work again ends the match.
    if (FATAL_PEER_ERRORS.has(err.type)) fireClose()
  }
  function onPeerClose(): void {
    fireClose()
  }

  conn.on('data', onData)
  conn.on('close', onConnClose)
  conn.on('error', onConnError)
  peer.on('error', onPeerError)
  peer.on('disconnected', onPeerDisconnected)
  peer.on('close', onPeerClose)

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
      detach()
      peer.destroy()
    },
  }
}

export function hostSession(
  name: string,
  onCode: (code: string) => void,
  onGuestFailed?: (err: Error) => void,
): CancellablePromise<NetSession> {
  return cancellableSession(({ setPeer, succeed, fail, isSettled, waitFor }) => {
    let tries = 0
    let claimed: DataConnection | null = null

    const attempt = (): void => {
      tries += 1
      const code = randomCode()
      const peer = new Peer(PEER_ID_PREFIX + code)
      setPeer(peer)
      let announced = false
      let rejoinTries = 0

      peer.on('open', () => {
        if (isSettled()) return
        // The room exists; from here we are waiting on a person, not a server.
        waitFor(HOST_WAIT_MS, HOST_WAIT_MESSAGE)
        // A reconnect re-opens the same room under the same id, so the link the
        // player has already sent out stays the right one.
        if (announced) return
        announced = true
        onCode(code)
      })
      /**
       * A dropped signalling socket makes the room unreachable while it still
       * looks open — the link goes quietly dead. Over a wait this long that is
       * worth recovering from; if recovery fails PeerJS raises an error and the
       * attempt ends loudly, as before.
       */
      peer.on('disconnected', () => {
        if (isSettled() || peer.destroyed || rejoinTries >= MAX_RECONNECT_TRIES) return
        rejoinTries += 1
        const delay = Math.min(
          RECONNECT_DELAY_MS * 2 ** (rejoinTries - 1),
          RECONNECT_MAX_DELAY_MS,
        )
        setTimeout(() => {
          if (isSettled() || peer.destroyed || !peer.disconnected) return
          try {
            peer.reconnect()
          } catch (err) {
            console.warn('p2p: host signalling reconnect failed', err)
          }
        }, delay)
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
        // Someone is here: a handshake that stalls must not sit on the long
        // waiting-for-a-friend deadline.
        waitFor(CONNECT_TIMEOUT_MS, 'Connection timed out')

        /**
         * A guest that fails mid-handshake takes down its own connection, not
         * the room: the link is already out in a chat somewhere, so the next
         * person to click it deserves an open door.
         */
        let released = false
        const releaseGuest = (err: Error): void => {
          if (released || isSettled()) return
          released = true
          claimed = null
          conn.close()
          waitFor(HOST_WAIT_MS, HOST_WAIT_MESSAGE)
          onGuestFailed?.(err)
        }

        exchangeHello(peer, conn, 'host', name, succeed, releaseGuest)
      })
    }

    attempt()
  })
}

export function joinSession(code: string, name: string): CancellablePromise<NetSession> {
  return cancellableSession(({ setPeer, succeed, fail, isSettled }) => {
    const normalized = normalizeCode(code)
    if (!isRoomCode(normalized)) {
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
