import { describe, expect, it } from 'vitest'
import { createBotSession } from './bot-session'
import { BOT_LEVELS, BOT_LEVEL_ORDER, COLS, CURSE_KINDS, ROWS } from '../types'
import type { BotLevel, BotSession, NetMsg } from '../types'

// The bot has no clock of its own: `update(dt)` is the only time it knows
// about, so every test here drives it in fixed 60 Hz steps and reads the wire.
// Nothing pokes at its Game — the whole point of the design is that the only
// visible surface is the NetSession, so that is all the tests are allowed.

const STEP = 1 / 60
const CELL_COUNT = ROWS * COLS

type StateMsg = Extract<NetMsg, { t: 'state' }>
type CurseMsg = Extract<NetMsg, { t: 'curse' }>

/** The bot reuses one snapshot object per session, so a recorder must copy. */
function record(bot: BotSession): NetMsg[] {
  const out: NetMsg[] = []
  bot.session.onMessage((msg) => {
    out.push(JSON.parse(JSON.stringify(msg)) as NetMsg)
  })
  return out
}

function drive(bot: BotSession, seconds: number): void {
  const steps = Math.round(seconds / STEP)
  for (let i = 0; i < steps; i++) bot.update(STEP)
}

function statesOf(msgs: readonly NetMsg[]): StateMsg[] {
  return msgs.filter((m): m is StateMsg => m.t === 'state')
}

function cursesOf(msgs: readonly NetMsg[]): CurseMsg[] {
  return msgs.filter((m): m is CurseMsg => m.t === 'curse')
}

function filled(grid: readonly number[]): number {
  let n = 0
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] >= 0) n++
  }
  return n
}

/** How many snapshots showed a higher score than the one before it. */
function scoreBumps(msgs: readonly NetMsg[]): number {
  let bumps = 0
  let prev = 0
  for (const s of statesOf(msgs)) {
    if (s.score > prev) bumps++
    prev = s.score
  }
  return bumps
}

describe('createBotSession', () => {
  it('presents itself as the host peer, named after its level', () => {
    for (const level of BOT_LEVEL_ORDER) {
      const bot = createBotSession({ seed: 1, level, difficulty: 'normal' })
      // 'host' is load-bearing: only a host-side controller mints a rematch
      // seed, and with a bot on the far end the human has to be the one doing
      // it. See the note at the top of bot-session.ts.
      expect(bot.session.role).toBe('host')
      expect(bot.session.peerName).toBe(`${BOT_LEVELS[level].label} AI`)
      bot.dispose()
    }
  })

  it('plays a real game instead of stalling on the launcher', () => {
    for (const level of BOT_LEVEL_ORDER) {
      const bot = createBotSession({ seed: 5, level, difficulty: 'normal' })
      const msgs = record(bot)
      drive(bot, 30)

      const states = statesOf(msgs)
      expect(states.length).toBeGreaterThan(10)

      // A bot frozen in 'aiming' would only ever gain the odd colour match a
      // garbage row happened to complete. Repeated scoring spread across the
      // run is launch after launch resolving.
      expect(scoreBumps(msgs)).toBeGreaterThanOrEqual(8)
      expect(states[states.length - 1].score).toBeGreaterThan(500)
      expect(states[states.length - 1].grid).not.toEqual(states[0].grid)
      bot.dispose()
    }
  })

  it('emits snapshots at ~5 Hz with a well-formed grid', () => {
    const bot = createBotSession({ seed: 11, level: 'skilled', difficulty: 'normal' })
    const msgs = record(bot)
    drive(bot, 30)

    const states = statesOf(msgs)
    const hz = states.length / 30
    expect(hz).toBeGreaterThan(4.5)
    expect(hz).toBeLessThan(5.5)

    for (const s of states) {
      expect(s.grid.length).toBe(CELL_COUNT)
      expect(typeof s.score).toBe('number')
      expect(typeof s.danger).toBe('boolean')
      for (const v of s.grid) {
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(-1)
        expect(v).toBeLessThanOrEqual(3)
      }
    }
    bot.dispose()
  })

  it('applies a curse it is sent, visibly', () => {
    const bot = createBotSession({ seed: 3, level: 'skilled', difficulty: 'normal' })
    const msgs = record(bot)
    drive(bot, 1)

    const before = statesOf(msgs)
    expect(before.length).toBeGreaterThan(0)
    const beforeFill = filled(before[before.length - 1].grid)

    // Three `garbage` curses are six rows: far more than a lock or a rise could
    // account for in the fifth of a second before the next snapshot.
    for (let i = 0; i < 3; i++) bot.session.send({ t: 'curse', kind: 'garbage' })
    drive(bot, 0.4)

    const after = statesOf(msgs)
    expect(after.length).toBeGreaterThan(before.length)
    expect(filled(after[after.length - 1].grid) - beforeFill).toBeGreaterThan(30)
    bot.dispose()
  })

  it('shrugs off malformed traffic and keeps playing', () => {
    const bot = createBotSession({ seed: 3, level: 'skilled', difficulty: 'normal' })
    const msgs = record(bot)

    const junk: unknown[] = [
      null,
      undefined,
      42,
      'curse',
      [],
      {},
      { t: 'nope' },
      { t: 42 },
      { t: null },
      { t: 'curse' },
      { t: 'curse', kind: 'nonsense' },
      { t: 'curse', kind: 7 },
      { t: 'curse', kind: null },
      { t: 'rematchAccept' },
      { t: 'rematchAccept', seed: 'soon' },
      { t: 'rematchAccept', seed: Number.NaN },
      { t: 'rematchAccept', seed: Number.POSITIVE_INFINITY },
      { t: 'state', grid: null },
      { t: 'state', grid: [1, 2, 3], score: 'lots' },
      { t: 'hello' },
      { t: 'start' },
    ]
    for (const bad of junk) {
      expect(() => bot.session.send(bad as NetMsg)).not.toThrow()
    }

    drive(bot, 5)
    expect(statesOf(msgs).length).toBeGreaterThan(10)
    // A game over missing its score is still a game over, so it goes last: it
    // legitimately parks the bot and would have poisoned the checks above.
    expect(() => bot.session.send({ t: 'gameOver' } as unknown as NetMsg)).not.toThrow()
    bot.dispose()
  })

  it('sends on a curse once it has caught a power bubble', () => {
    const bot = createBotSession({ seed: 42, level: 'merciless', difficulty: 'normal' })
    const msgs = record(bot)
    // Power bubbles only spawn on a clear and only stick around for a few
    // seconds, so catching one is proof the bot both cleared and flew.
    drive(bot, 40)

    const curses = cursesOf(msgs)
    expect(curses.length).toBeGreaterThan(0)
    for (const c of curses) {
      expect(CURSE_KINDS).toContain(c.kind)
    }
    bot.dispose()
  })

  it('goes quiet when told the human topped out', () => {
    const bot = createBotSession({ seed: 8, level: 'skilled', difficulty: 'normal' })
    const msgs = record(bot)
    drive(bot, 5)
    expect(msgs.length).toBeGreaterThan(0)

    bot.session.send({ t: 'gameOver', score: 1234 })
    msgs.length = 0
    drive(bot, 5)
    expect(msgs).toEqual([])
    bot.dispose()
  })

  it('agrees to a rematch and plays the fresh seed', () => {
    const bot = createBotSession({ seed: 8, level: 'skilled', difficulty: 'normal' })
    const msgs = record(bot)
    drive(bot, 20)
    const beforeScore = statesOf(msgs).pop()?.score ?? 0
    expect(beforeScore).toBeGreaterThan(0)

    bot.session.send({ t: 'gameOver', score: 999 })
    msgs.length = 0

    // The echo is what sets `remoteWant` on the human's controller; without it
    // the handshake never closes.
    bot.session.send({ t: 'rematchRequest' })
    drive(bot, STEP)
    expect(msgs).toEqual([{ t: 'rematchRequest' }])

    msgs.length = 0
    bot.session.send({ t: 'rematchAccept', seed: 4242 })
    drive(bot, 20)

    const states = statesOf(msgs)
    expect(states.length).toBeGreaterThan(10)
    // A fresh game, not a continuation of the one that just ended.
    expect(states[0].score).toBe(0)
    expect(states[states.length - 1].score).toBeGreaterThan(0)
    bot.dispose()
  })

  it('reports its own game over exactly once, then says nothing', () => {
    const bot = createBotSession({ seed: 1, level: 'skilled', difficulty: 'normal' })
    const msgs = record(bot)
    drive(bot, 5)

    msgs.length = 0
    // Twelve garbage curses is twenty-four rows: nothing survives that.
    for (let i = 0; i < 12; i++) bot.session.send({ t: 'curse', kind: 'garbage' })
    drive(bot, 10)

    expect(msgs.filter((m) => m.t === 'gameOver')).toEqual([
      { t: 'gameOver', score: expect.any(Number) },
    ])
    const overAt = msgs.findIndex((m) => m.t === 'gameOver')
    expect(msgs.slice(overAt + 1)).toEqual([])
    bot.dispose()
  })

  it('close() stops it dead and later updates are no-ops', () => {
    const bot = createBotSession({ seed: 2, level: 'skilled', difficulty: 'normal' })
    const msgs = record(bot)
    drive(bot, 5)
    expect(msgs.length).toBeGreaterThan(0)

    bot.session.close()
    msgs.length = 0
    drive(bot, 10)
    expect(msgs).toEqual([])

    // A closed session must also swallow whatever the controller sends next.
    expect(() => bot.session.send({ t: 'curse', kind: 'garbage' })).not.toThrow()
    expect(() => bot.session.send({ t: 'rematchRequest' })).not.toThrow()
    drive(bot, 1)
    expect(msgs).toEqual([])
    bot.dispose()
  })

  it('dispose() detaches the listeners as well', () => {
    const bot = createBotSession({ seed: 2, level: 'skilled', difficulty: 'normal' })
    const msgs = record(bot)
    drive(bot, 5)
    expect(msgs.length).toBeGreaterThan(0)

    bot.dispose()
    msgs.length = 0
    drive(bot, 10)
    expect(msgs).toEqual([])
  })

  it('onMessage unsubscribes', () => {
    const bot = createBotSession({ seed: 2, level: 'skilled', difficulty: 'normal' })
    let count = 0
    const off = bot.session.onMessage(() => {
      count++
    })
    drive(bot, 2)
    expect(count).toBeGreaterThan(0)

    off()
    const seen = count
    drive(bot, 2)
    expect(count).toBe(seen)
    bot.dispose()
  })

  it('is reproducible: same seed and level, same wire traffic', () => {
    for (const level of BOT_LEVEL_ORDER) {
      const streams: string[] = []
      for (let run = 0; run < 2; run++) {
        const bot = createBotSession({ seed: 777, level, difficulty: 'normal' })
        const msgs = record(bot)
        const steps = Math.round(25 / STEP)
        for (let i = 0; i < steps; i++) {
          // Identical interference on both runs, so the reproducibility being
          // asserted covers the reactive paths too, not just free play.
          if (i === 600) bot.session.send({ t: 'curse', kind: 'garbage' })
          if (i === 900) bot.session.send({ t: 'curse', kind: 'speed' })
          bot.update(STEP)
        }
        bot.dispose()
        streams.push(JSON.stringify(msgs))
      }
      expect(streams[0]).toBe(streams[1])
      expect(streams[0].length).toBeGreaterThan(1000)
    }
  })

  it('two levels of the same seed genuinely play differently', () => {
    const play = (level: BotLevel): string => {
      const bot = createBotSession({ seed: 777, level, difficulty: 'normal' })
      const msgs = record(bot)
      drive(bot, 25)
      bot.dispose()
      return JSON.stringify(statesOf(msgs).map((s) => s.grid))
    }
    expect(play('rookie')).not.toBe(play('merciless'))
  })
})
