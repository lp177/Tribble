// Invite links end to end: the host copies a link, and opening that link is by
// itself enough to land the guest in the match — no code read, typed or pasted.
//
// Everything here runs against two real PeerJS peers on the public broker, so
// the waits are generous and every failure prints what it actually saw.
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:4173/'
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
// The copy button takes the async-clipboard path when it is allowed to.
await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
  origin: new URL(base).origin,
})

const errors = []
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`[pageerror ${tag}] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[error ${tag}] ${m.text()}`)
  })
}

/** Poll `fn` until it returns something truthy, or give up after `ms`. */
const until = async (page, fn, ms = 30_000, step = 500) => {
  for (let waited = 0; waited < ms; waited += step) {
    const value = await fn()
    if (value) return value
    await page.waitForTimeout(step)
  }
  return null
}

const inMatch = (page) =>
  page.evaluate(() => {
    const hud = document.body.innerText.toLowerCase()
    return !hud.includes('host game') && !hud.includes('join game')
  })

// --- Host: a room yields a link, not just a code -----------------------------
const host = await context.newPage()
watch(host, 'host')
await host.goto(base, { waitUntil: 'networkidle' })
await host.waitForTimeout(800)
await host.getByRole('button', { name: /versus/i }).click()
await host.waitForTimeout(300)
await host.getByRole('button', { name: /host game/i }).click()

const link = await until(host, async () => {
  const value = await host.locator('#invite-link').inputValue().catch(() => '')
  return value.length > 0 ? value : null
})
check('invite link offered to the host', link !== null, link ?? 'none within 30s')

const code = await host.locator('#room-code').textContent()
check(
  'link carries the room code in its fragment',
  link !== null && link.includes(`#r=${code.trim()}`),
  `${link} vs code ${code}`,
)
check(
  'room code still shown as the spoken fallback',
  /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test((code ?? '').trim()),
  code,
)

// --- The copy button actually puts it on the clipboard -----------------------
await host.getByRole('button', { name: /copy invite link/i }).click()
await host.waitForTimeout(400)
const clipboard = await host.evaluate(() => navigator.clipboard.readText()).catch(() => '')
check('copy button writes the link to the clipboard', clipboard === link, clipboard || 'empty')
const copiedLabel = await host
  .getByRole('button', { name: /link copied/i })
  .isVisible()
  .catch(() => false)
check('copy button confirms visually', copiedLabel)

// --- Guest: opening the link is the whole flow -------------------------------
const guest = await context.newPage()
watch(guest, 'guest')
await guest.goto(link, { waitUntil: 'networkidle' })

const joined = await until(guest, async () =>
  (await inMatch(guest)) && (await inMatch(host)) ? true : null,
)
check('opening the invite link joins the match with no typing', joined === true)

const cleanedUrl = await guest.evaluate(() => window.location.href)
check(
  'the code is taken back out of the address bar',
  !cleanedUrl.includes('#r='),
  cleanedUrl,
)

if (joined) {
  // Both boards must be live, not just past the menu.
  for (let i = 0; i < 4; i++) {
    await host.keyboard.press('Space')
    await guest.keyboard.press('ArrowRight')
    await guest.keyboard.press('Space')
    await host.waitForTimeout(400)
  }
  await host.screenshot({ path: '/tmp/tribble-invite-host.png' })
  await guest.screenshot({ path: '/tmp/tribble-invite-guest.png' })
}
await guest.close()
await host.close()

// --- Pasting a link into the join field works too -----------------------------
const host2 = await context.newPage()
watch(host2, 'host2')
await host2.goto(base, { waitUntil: 'networkidle' })
await host2.waitForTimeout(600)
await host2.getByRole('button', { name: /versus/i }).click()
await host2.waitForTimeout(300)
await host2.getByRole('button', { name: /host game/i }).click()
const link2 = await until(host2, async () => {
  const value = await host2.locator('#invite-link').inputValue().catch(() => '')
  return value.length > 0 ? value : null
})

const guest2 = await context.newPage()
watch(guest2, 'guest2')
await guest2.goto(base, { waitUntil: 'networkidle' })
await guest2.waitForTimeout(600)
await guest2.getByRole('button', { name: /versus/i }).click()
await guest2.waitForTimeout(300)
await guest2.locator('#join-code').fill(link2 ?? '')
await guest2.waitForTimeout(200)
const collapsed = await guest2.locator('#join-code').inputValue()
check(
  'a link pasted into the join field collapses to the code',
  /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(collapsed),
  collapsed,
)
await guest2.getByRole('button', { name: /^join$/i }).click()
const joined2 = await until(guest2, async () =>
  (await inMatch(guest2)) && (await inMatch(host2)) ? true : null,
)
check('joining from a pasted link connects', joined2 === true)
await guest2.close()
await host2.close()

// --- A guest that dies mid-handshake must not take the room with it ----------
// The link is already out in a chat somewhere, so the door has to stay open.
// A raw PeerJS peer connects to the room and never says hello, which is exactly
// what a friend on a flaky connection looks like from the host's side.
const host3 = await context.newPage()
watch(host3, 'host3')
await host3.goto(base, { waitUntil: 'networkidle' })
await host3.waitForTimeout(600)
await host3.getByRole('button', { name: /versus/i }).click()
await host3.waitForTimeout(300)
await host3.getByRole('button', { name: /host game/i }).click()
const link3 = await until(host3, async () => {
  const value = await host3.locator('#invite-link').inputValue().catch(() => '')
  return value.length > 0 ? value : null
})
const code3 = (await host3.locator('#room-code').textContent()).trim()

const ghost = await context.newPage()
await ghost.goto(base, { waitUntil: 'networkidle' })
await ghost.addScriptTag({ path: 'node_modules/peerjs/dist/peerjs.min.js' })
await ghost.evaluate(async (roomCode) => {
  const peer = new window.Peer()
  await new Promise((resolve) => peer.on('open', resolve))
  const conn = peer.connect(`tribble-${roomCode}`, { reliable: true, serialization: 'json' })
  await new Promise((resolve) => {
    conn.on('open', resolve)
    setTimeout(resolve, 8000)
  })
  // Not a word of protocol, then gone.
  peer.destroy()
}, code3)
await ghost.close()
await host3.waitForTimeout(1500)

const stillHosting = await host3.evaluate(() => {
  const el = document.getElementById('room-code')
  return el && !el.hidden ? el.textContent.trim() : null
})
check('a silent guest does not close the room', stillHosting === code3, `${stillHosting} vs ${code3}`)

const guest3 = await context.newPage()
watch(guest3, 'guest3')
await guest3.goto(link3, { waitUntil: 'networkidle' })
const joined3 = await until(guest3, async () =>
  (await inMatch(guest3)) && (await inMatch(host3)) ? true : null,
)
check('the same link still works after a failed guest', joined3 === true)
await guest3.close()
await host3.close()

await browser.close()
console.log('\n--- page errors ---')
console.log(errors.length ? errors.slice(0, 20).join('\n') : '(none)')
process.exit(failures > 0 || errors.length > 0 ? 1 : 0)
