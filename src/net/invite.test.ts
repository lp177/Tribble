import { describe, expect, it } from 'vitest'
import {
  CODE_CHARS,
  CODE_LENGTH,
  buildInviteUrl,
  extractRoomCode,
  hrefWithoutInvite,
  isRoomCode,
  normalizeCode,
  parseInviteCode,
  randomCode,
} from './invite'

// Everything here is the pure half of the module: the browser-facing wrappers
// only read `location` and hand these the href. The link is a contract with
// whatever chat app carried it, so the parser is deliberately forgiving about
// the forms it accepts and strict about what it calls a code.

const PAGE = 'https://lp177.github.io/Tribble/'

describe('room codes', () => {
  it('generates codes from the lookalike-free alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = randomCode()
      expect(code).toHaveLength(CODE_LENGTH)
      expect(isRoomCode(code)).toBe(true)
      for (const ch of code) expect(CODE_CHARS).toContain(ch)
    }
  })

  it('normalizes case and separators away', () => {
    expect(normalizeCode(' ab-c 23 ')).toBe('ABC23')
    expect(normalizeCode('abc23')).toBe('ABC23')
  })

  it('rejects anything outside the alphabet or the length', () => {
    expect(isRoomCode('ABC2')).toBe(false)
    expect(isRoomCode('ABC234')).toBe(false)
    // I, O, 0 and 1 are excluded on purpose: they are never in a real code.
    expect(isRoomCode('ABCI3')).toBe(false)
    expect(isRoomCode('ABC03')).toBe(false)
    expect(isRoomCode('abc23')).toBe(false)
  })
})

describe('buildInviteUrl', () => {
  it('puts the code in the fragment of the page it was built from', () => {
    expect(buildInviteUrl(PAGE, 'ABC23')).toBe(`${PAGE}#r=ABC23`)
  })

  it('replaces a code the current URL is already carrying', () => {
    expect(buildInviteUrl(`${PAGE}#r=ZZZZZ`, 'ABC23')).toBe(`${PAGE}#r=ABC23`)
    expect(buildInviteUrl(`${PAGE}?r=ZZZZZ`, 'ABC23')).toBe(`${PAGE}#r=ABC23`)
  })

  it('keeps the rest of the URL intact', () => {
    expect(buildInviteUrl('http://localhost:4173/?debug=1', 'ABC23')).toBe(
      'http://localhost:4173/?debug=1#r=ABC23',
    )
  })

  it('round-trips through the parser', () => {
    for (let i = 0; i < 50; i++) {
      const code = randomCode()
      expect(parseInviteCode(buildInviteUrl(PAGE, code))).toBe(code)
    }
  })
})

describe('parseInviteCode', () => {
  it('reads the fragment form the app emits', () => {
    expect(parseInviteCode(`${PAGE}#r=ABC23`)).toBe('ABC23')
  })

  it('accepts the aliases and a bare fragment', () => {
    expect(parseInviteCode(`${PAGE}#room=ABC23`)).toBe('ABC23')
    expect(parseInviteCode(`${PAGE}#join=ABC23`)).toBe('ABC23')
    expect(parseInviteCode(`${PAGE}#ABC23`)).toBe('ABC23')
  })

  it('accepts the query form, in case a link was rewritten in transit', () => {
    expect(parseInviteCode(`${PAGE}?r=ABC23`)).toBe('ABC23')
    expect(parseInviteCode(`${PAGE}?utm=chat&room=abc23`)).toBe('ABC23')
  })

  it('is case-insensitive: chat apps lowercase links', () => {
    expect(parseInviteCode(`${PAGE}#r=abc23`)).toBe('ABC23')
  })

  it('returns null when there is no code to find', () => {
    expect(parseInviteCode(PAGE)).toBeNull()
    expect(parseInviteCode(`${PAGE}#`)).toBeNull()
    expect(parseInviteCode(`${PAGE}#settings`)).toBeNull()
    expect(parseInviteCode(`${PAGE}#r=NOPE`)).toBeNull()
    // Lookalike characters mean a mistyped code, not a room.
    expect(parseInviteCode(`${PAGE}#r=ABC0I`)).toBeNull()
    expect(parseInviteCode('not a url at all')).toBeNull()
  })
})

describe('extractRoomCode', () => {
  it('takes a plain code, however it was typed', () => {
    expect(extractRoomCode('ABC23')).toBe('ABC23')
    expect(extractRoomCode('  abc23 ')).toBe('ABC23')
    expect(extractRoomCode('ab c-23')).toBe('ABC23')
  })

  it('takes a pasted invite link', () => {
    expect(extractRoomCode(`${PAGE}#r=ABC23`)).toBe('ABC23')
    expect(extractRoomCode(`  ${PAGE}#r=abc23  `)).toBe('ABC23')
  })

  it('takes a link with a message wrapped around it', () => {
    expect(extractRoomCode(`hey join me: ${PAGE}#r=ABC23 now!`)).toBe('ABC23')
  })

  it('takes a link with the scheme or host chopped off', () => {
    expect(extractRoomCode('lp177.github.io/Tribble/#r=ABC23')).toBe('ABC23')
    expect(extractRoomCode('/Tribble/#r=ABC23')).toBe('ABC23')
    expect(extractRoomCode('#r=ABC23')).toBe('ABC23')
  })

  it('returns null for partial input and for text carrying no code', () => {
    expect(extractRoomCode('')).toBeNull()
    expect(extractRoomCode('AB')).toBeNull()
    expect(extractRoomCode('ABC234')).toBeNull()
    expect(extractRoomCode(PAGE)).toBeNull()
    expect(extractRoomCode('https://example.com/')).toBeNull()
  })
})

describe('hrefWithoutInvite', () => {
  it('strips the code the app has already acted on', () => {
    expect(hrefWithoutInvite(`${PAGE}#r=ABC23`)).toBe(PAGE)
    expect(hrefWithoutInvite(`${PAGE}#ABC23`)).toBe(PAGE)
    expect(hrefWithoutInvite(`${PAGE}?r=ABC23`)).toBe(PAGE)
  })

  it('leaves a URL that carries no code alone', () => {
    expect(hrefWithoutInvite(PAGE)).toBe(PAGE)
    // Not ours to clear: some other fragment is somebody else's state.
    expect(hrefWithoutInvite(`${PAGE}#settings`)).toBe(`${PAGE}#settings`)
  })
})
