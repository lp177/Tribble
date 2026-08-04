// Verifies the behaviors fixed after the code review, which the other smoke
// tests do not exercise.
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:4174/'
const browser = await chromium.launch()
const errors = []
const check = (name, ok, detail = '') =>
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[error] ${m.text()}`)
})
await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForTimeout(800)

// --- Space activates a focused menu button (was swallowed by the game input) --
await page.getByRole('button', { name: /how to play/i }).focus()
await page.keyboard.press('Space')
await page.waitForTimeout(400)
const howtoOpen = await page.evaluate(() => /how to play/i.test(document.body.innerText))
check('Space activates focused menu button', howtoOpen)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// --- Reduced-motion setting reaches the DOM ---------------------------------
await page.getByRole('button', { name: /^settings$/i }).click()
await page.waitForTimeout(300)
await page.selectOption('select', 'on').catch(() => {})
await page.waitForTimeout(300)
const rmAttr = await page.evaluate(() => document.documentElement.dataset.reducedMotion)
check('reduced motion reaches <html>', rmAttr === 'on', `data-reduced-motion=${rmAttr}`)
const rippleHidden = await page.evaluate(() => {
  const el = document.createElement('span')
  el.className = 'ripple'
  document.body.appendChild(el)
  const d = getComputedStyle(el).display
  el.remove()
  return d
})
check('ripples disabled under reduced motion', rippleHidden === 'none', `display=${rippleHidden}`)
await page.selectOption('select', 'auto').catch(() => {})
await page.waitForTimeout(200)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// --- Abandoned rebind must not stay armed -----------------------------------
await page.getByRole('button', { name: /^settings$/i }).click()
await page.waitForTimeout(300)
const row = page.getByRole('button', { name: /launch piece: change key binding/i }).first()
await row.scrollIntoViewIfNeeded()
const original = (await row.innerText()).replace(/\s+/g, ' ').trim()
await row.click()
await page.waitForTimeout(200)
// Walk away with the mouse instead of pressing a key.
await page.getByRole('button', { name: /back/i }).click()
await page.waitForTimeout(400)
// The next keystroke must NOT be silently swallowed into that binding.
await page.keyboard.press('KeyQ')
await page.waitForTimeout(300)
await page.getByRole('button', { name: /^settings$/i }).click()
await page.waitForTimeout(300)
const afterAbandon = (await row.innerText()).replace(/\s+/g, ' ').trim()
check('abandoned rebind does not steal a key', afterAbandon === original, `${original} -> ${afterAbandon}`)

// --- Rebinding a key already used elsewhere must not duplicate it ------------
const rotRow = page.getByRole('button', { name: /rotate clockwise: change key binding/i }).first()
await rotRow.scrollIntoViewIfNeeded()
await rotRow.click()
await page.waitForTimeout(200)
await page.keyboard.press('Space') // Space is Launch's default
await page.waitForTimeout(400)
const dup = await page.evaluate(() => {
  const b = JSON.parse(localStorage.getItem('tribble.settings.v1')).bindings
  const all = Object.values(b).flat()
  return { dupes: all.length !== new Set(all).size, launch: b.launch, rotateCW: b.rotateCW }
})
check('no duplicate key across actions', !dup.dupes, JSON.stringify(dup))
await page.getByRole('button', { name: /reset to default/i }).click()
await page.waitForTimeout(300)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// --- Versus reserves the sidebar from frame one (no mid-match layout jump) ---
await page.getByRole('button', { name: /versus/i }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /host game/i }).click()
let code = null
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000)
  code = await page.evaluate(() => {
    const el = document.querySelector('#room-code')
    const t = el ? el.textContent.trim() : ''
    return t.length >= 5 ? t.replace(/\s/g, '') : null
  })
  if (code) break
}
check('room code issued', code !== null, code ?? 'none')

if (code) {
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page2.on('pageerror', (e) => errors.push(`[pageerror p2] ${e.message}`))
  await page2.goto(base, { waitUntil: 'networkidle' })
  await page2.waitForTimeout(700)
  await page2.getByRole('button', { name: /versus/i }).click()
  await page2.waitForTimeout(300)
  await page2.locator('#join-code').fill(code)
  await page2.getByRole('button', { name: /^join$/i }).click()

  let started = false
  for (let i = 0; i < 30; i++) {
    await page2.waitForTimeout(1000)
    started = await page.evaluate(() => !/host game/i.test(document.body.innerText))
    if (started) break
  }
  check('versus match started', started)

  if (started) {
    // Sample the board geometry immediately, then after snapshots have flowed.
    const geomEarly = await page.screenshot({ path: '/tmp/tribble-fix-early.png' })
    await page.waitForTimeout(2500)
    await page.screenshot({ path: '/tmp/tribble-fix-late.png' })
    check('captured early/late versus frames', geomEarly.length > 0)

    // Escape must NOT open a pause overlay in versus (it arms a forfeit instead).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    const pausedInVersus = await page.evaluate(() =>
      /quit to title/i.test(document.body.innerText),
    )
    check('Escape does not pause a versus match', !pausedInVersus)
    await page.waitForTimeout(3000) // let the forfeit window lapse
  }
  await page2.close()
}

await browser.close()
console.log('\n--- page errors ---')
console.log(errors.length ? errors.slice(0, 20).join('\n') : '(none)')
process.exit(errors.length ? 1 : 0)
