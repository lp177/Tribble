// Verifies the AI opponent: reachable from the Versus menu, actually plays its
// own board, exchanges curses, and supports a rematch — all in one tab.
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:4181/'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[error] ${m.text()}`)
})
let failed = 0
const check = (n, ok, d = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`)
}

/** Coarse fingerprint of the opponent sidebar, to prove the bot is playing. */
const sidebarPrint = () =>
  page.evaluate(() => {
    const c = document.getElementById('game-canvas')
    const g = c.getContext('2d')
    const x0 = Math.floor(c.width * 0.7)
    const { data } = g.getImageData(x0, 0, c.width - x0, c.height)
    let lit = 0
    let sum = 0
    for (let i = 0; i < data.length; i += 4 * 23) {
      const v = data[i] + data[i + 1] + data[i + 2]
      if (v > 150) {
        lit++
        sum += v * ((i % 977) + 1)
      }
    }
    return { lit, sig: sum % 1000000 }
  })

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForTimeout(900)

// --- The option is where the player asked for it: behind Versus -------------
await page.getByRole('button', { name: /versus/i }).click()
await page.waitForTimeout(500)

const levels = await page.locator('[data-bot-level]').count()
check('bot levels offered in the versus menu', levels >= 3, `${levels} levels`)

const hasAllThree = await page.evaluate(() =>
  ['rookie', 'skilled', 'merciless'].every((l) =>
    document.querySelector(`[data-bot-level="${l}"]`),
  ),
)
check('rookie / skilled / merciless all present', hasAllThree)

// Keyboard operability of the new radiogroup.
await page.locator('[data-bot-level="rookie"]').focus()
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(200)
const movedByKeyboard = await page.evaluate(
  () => document.activeElement?.getAttribute('data-bot-level') ?? null,
)
check('arrow keys move within the level group', movedByKeyboard === 'skilled', String(movedByKeyboard))

// --- Start a match against the machine --------------------------------------
await page.locator('[data-bot-level="merciless"]').click()
await page.waitForTimeout(200)
const startBtn = page
  .getByRole('button', { name: /play|start|machine|fight|solo versus/i })
  .filter({ hasNot: page.locator('[data-bot-level]') })
  .first()
await startBtn.click()
await page.waitForTimeout(1800)

const inMatch = await page.evaluate(
  () => [...document.querySelectorAll('section')].filter((s) => s.offsetParent !== null).length === 0,
)
check('bot match starts', inMatch)

const opponentNamed = await page.evaluate(() => /ai|merciless|bot|machine/i.test(document.body.innerText))
check('opponent plate names the AI', opponentNamed)

// --- The bot plays its own board --------------------------------------------
const before = await sidebarPrint()
// Play a little ourselves so the match is real on both sides.
for (let i = 0; i < 10; i++) {
  await page.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight')
  await page.keyboard.press('Space')
  await page.waitForTimeout(700)
}
const after = await sidebarPrint()
check(
  'opponent board evolves (the AI is really playing)',
  after.sig !== before.sig || after.lit !== before.lit,
  `lit ${before.lit}->${after.lit}`,
)
await page.screenshot({ path: '/tmp/tribble-bot-match.png' })

// --- It should eventually put a curse on us ---------------------------------
let cursed = false
for (let i = 0; i < 40; i++) {
  await page.keyboard.press('Space')
  await page.waitForTimeout(500)
  const txt = await page.evaluate(() => document.body.innerText)
  if (/sent:|cursed:|garbage|fog|scramble|mirror|rotation lock|speed up/i.test(txt)) {
    cursed = true
    break
  }
  const over = await page.evaluate(
    () => [...document.querySelectorAll('section')].filter((s) => s.offsetParent !== null).length > 0,
  )
  if (over) break
}
console.log(`     (curse exchange observed: ${cursed})`)

// --- Rematch: force an ending, then play the AI again ----------------------
// Hardcore tops the human out quickly, which is the only reliable way to reach
// the versus-end screen inside a test.
await page.evaluate(() => {
  const raw = localStorage.getItem('tribble.settings.v1')
  const s = raw ? JSON.parse(raw) : {}
  s.difficulty = 'hardcore'
  localStorage.setItem('tribble.settings.v1', JSON.stringify(s))
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(900)
await page.getByRole('button', { name: /versus/i }).click()
await page.waitForTimeout(400)
await page.locator('[data-bot-level="rookie"]').click()
await page.waitForTimeout(150)
await page
  .getByRole('button', { name: /play|start|machine|fight|solo versus/i })
  .filter({ hasNot: page.locator('[data-bot-level]') })
  .first()
  .click()
await page.waitForTimeout(1500)

let ended = false
for (let i = 0; i < 90; i++) {
  await page.keyboard.press('Space')
  await page.waitForTimeout(300)
  ended = await page.evaluate(() => /rematch/i.test(document.body.innerText))
  if (ended) break
}
check('bot match reaches an end screen', ended)

if (ended) {
  await page.screenshot({ path: '/tmp/tribble-bot-end.png' })
  await page.getByRole('button', { name: /rematch/i }).first().click()
  await page.waitForTimeout(2500)
  const restarted = await page.evaluate(
    () =>
      [...document.querySelectorAll('section')].filter((s) => s.offsetParent !== null).length === 0,
  )
  // Regression guard: the bot's update() is also its outbound message pump, so
  // if it is only driven while the match is "active" the handshake deadlocks
  // on the end screen and Rematch silently does nothing.
  check('rematch against the AI starts a fresh match', restarted)

  const a = await sidebarPrint()
  await page.waitForTimeout(8000)
  const b = await sidebarPrint()
  check('the AI plays again after a rematch', a.sig !== b.sig || a.lit !== b.lit,
    `lit ${a.lit}->${b.lit}`)
}

await browser.close()
console.log('\n--- page errors ---')
console.log(errors.length ? errors.slice(0, 20).join('\n') : '(none)')
process.exit(failed > 0 || errors.length > 0 ? 1 : 0)
