// Room codes and the invite links that carry them.
//
// A room is still identified by a short code — it is the thing a player can
// read out over voice chat — but nobody should have to type it: the host
// shares a link that carries the code in the URL fragment, and the app joins
// straight from it on load.
//
// The fragment is deliberate. It never reaches the server, so the link works on
// any static host (GitHub Pages included), needs no routing rules, and the
// service worker keeps serving the very same cached shell for it.

/** No lookalikes: excludes I, O, 0, 1. */
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 5

/** The key an invite link uses: `#r=ABC23`. */
const INVITE_KEY = 'r'
/** Also accepted when reading a link, so older/hand-written forms still work. */
const INVITE_KEY_ALIASES: readonly string[] = [INVITE_KEY, 'room', 'join']

const CODE_RE = new RegExp(`^[${CODE_CHARS}]{${CODE_LENGTH}}$`)
/** A key=value invite pair anywhere inside a longer piece of pasted text. */
const EMBEDDED_RE = new RegExp(`[#?&](?:${INVITE_KEY_ALIASES.join('|')})=([a-z0-9]+)`, 'i')

export function randomCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

/** Uppercases and drops everything a code can never contain. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Strict: the code alphabet excludes lookalikes, so a character outside it
 * means the code is wrong — better to say so than to spend a round trip on it.
 */
export function isRoomCode(raw: string): boolean {
  return CODE_RE.test(raw)
}

/** The invite link for `code`, based on wherever the app is currently served. */
export function buildInviteUrl(baseHref: string, code: string): string {
  const url = new URL(baseHref)
  // A code left in the query by an older link must not shadow the new one.
  for (const key of INVITE_KEY_ALIASES) url.searchParams.delete(key)
  url.hash = `${INVITE_KEY}=${code}`
  return url.href
}

/** `#r=ABC23`, `#room=ABC23`, or a bare `#ABC23`. */
function codeFromFragment(hash: string): string | null {
  const raw = hash.replace(/^#/, '')
  if (raw === '') return null
  const params = new URLSearchParams(raw)
  for (const key of INVITE_KEY_ALIASES) {
    const value = params.get(key)
    if (value === null) continue
    const code = normalizeCode(value)
    return isRoomCode(code) ? code : null
  }
  const bare = normalizeCode(raw)
  return isRoomCode(bare) ? bare : null
}

/** The room code an invite URL points at, or null if it carries none. */
export function parseInviteCode(href: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const fromHash = codeFromFragment(url.hash)
  if (fromHash !== null) return fromHash
  for (const key of INVITE_KEY_ALIASES) {
    const value = url.searchParams.get(key)
    if (value === null) continue
    const code = normalizeCode(value)
    if (isRoomCode(code)) return code
  }
  return null
}

/**
 * The code inside anything a player might paste into the join field: the code
 * itself, a full invite link, or a link with a chat app's chatter around it.
 */
export function extractRoomCode(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  const direct = normalizeCode(trimmed)
  if (isRoomCode(direct)) return direct

  const fromUrl = parseInviteCode(trimmed)
  if (fromUrl !== null) return fromUrl

  // Not a URL on its own: a relative form, or a link inside a sentence.
  const embedded = EMBEDDED_RE.exec(trimmed)
  if (embedded !== null) {
    const code = normalizeCode(embedded[1])
    if (isRoomCode(code)) return code
  }
  return null
}

/** The href of the page, with any invite code stripped back off it. */
export function hrefWithoutInvite(href: string): string {
  const url = new URL(href)
  for (const key of INVITE_KEY_ALIASES) url.searchParams.delete(key)
  if (codeFromFragment(url.hash) !== null) url.hash = ''
  return url.href
}

// -- Browser-facing wrappers -------------------------------------------------

/** The invite code in the address bar right now, if any. */
export function currentInviteCode(): string | null {
  return parseInviteCode(window.location.href)
}

export function currentInviteUrl(code: string): string {
  return buildInviteUrl(window.location.href, code)
}

/**
 * Take the code out of the address bar once it has been acted on: a reload must
 * not silently try to re-join a room that is long gone, and the link the player
 * might then copy out of the bar would be a stale one.
 *
 * replaceState (not `location.hash = ''`) on purpose: it changes nothing else
 * and fires no hashchange, so it cannot loop back into the handler.
 */
export function clearInviteFromUrl(): void {
  const cleaned = hrefWithoutInvite(window.location.href)
  if (cleaned === window.location.href) return
  window.history.replaceState(window.history.state, '', cleaned)
}
