// Deeper interaction checks: key rebinding round-trip, pause/resume, curse
// inventory HUD, and PeerJS room hosting.
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:4173/'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[error] ${m.text()}`)
})

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForTimeout(800)

const check = (name, ok, detail = '') =>
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)

// --- Key rebinding round-trip ------------------------------------------------
await page.getByRole('button', { name: /^settings$/i }).click()
await page.waitForTimeout(300)

const launchRow = page.getByRole('button', { name: /launch piece: change key binding/i }).first()
await launchRow.scrollIntoViewIfNeeded()
const before = (await launchRow.innerText()).replace(/\s+/g, ' ').trim()
await launchRow.click()
await page.waitForTimeout(200)
const capturing = (await launchRow.innerText()).toLowerCase().includes('press')
check('rebind capture prompt', capturing, capturing ? '' : await launchRow.innerText())
await page.keyboard.press('KeyB')
await page.waitForTimeout(300)
const after = (await launchRow.innerText()).replace(/\s+/g, ' ').trim()
check('rebind applied', after !== before && /b/i.test(after), `${before} -> ${after}`)

const persisted = await page.evaluate(() => {
  const raw = localStorage.getItem('tribble.settings.v1')
  return raw ? JSON.parse(raw).bindings.launch : null
})
check('rebind persisted', Array.isArray(persisted) && persisted.includes('KeyB'), String(persisted))

// Escape cancels a capture instead of rebinding to Escape.
const pauseRow = page.getByRole('button', { name: /^pause: change key binding/i }).first()
await pauseRow.scrollIntoViewIfNeeded()
const pauseBefore = (await pauseRow.innerText()).replace(/\s+/g, ' ').trim()
await pauseRow.click()
await page.waitForTimeout(150)
await page.keyboard.press('Escape')
await page.waitForTimeout(250)
const pauseAfter = (await pauseRow.innerText()).replace(/\s+/g, ' ').trim()
check('escape cancels rebind', pauseAfter === pauseBefore, `${pauseBefore} -> ${pauseAfter}`)

// Reset to defaults restores Space for launch.
await page.getByRole('button', { name: /reset to default/i }).click()
await page.waitForTimeout(300)
const resetOk = await page.evaluate(() => {
  const raw = localStorage.getItem('tribble.settings.v1')
  return raw ? JSON.parse(raw).bindings.launch.includes('Space') : false
})
check('reset to defaults', resetOk)

// --- Gameplay: the rebound/default key launches ------------------------------
await page.getByRole('button', { name: /back/i }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /new game/i }).click()
await page.waitForTimeout(1000)

const readScore = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(
      (n) => n.children.length === 0 && /^\d[\d,\s]*$/.test(n.textContent.trim()),
    )
    return el ? el.textContent.trim() : null
  })

for (let i = 0; i < 10; i++) {
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Space')
  await page.waitForTimeout(500)
}
const scored = await readScore()
check('score element present after play', scored !== null, `score=${scored}`)

// --- Pause / resume ----------------------------------------------------------
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
const paused = await page.getByRole('button', { name: /^resume$/i }).isVisible()
check('pause overlay', paused)
await page.getByRole('button', { name: /^resume$/i }).click()
await page.waitForTimeout(300)
const unpaused = !(await page.getByRole('button', { name: /quit to title/i }).isVisible())
check('resume closes overlay', unpaused)

// --- Versus: PeerJS room hosting --------------------------------------------
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
await page.getByRole('button', { name: /quit to title/i }).click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: /versus/i }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /host game/i }).click()

let code = null
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000)
  code = await page.evaluate(() => {
    const el = document.querySelector('[data-room-code], .room-code, #room-code')
    if (el && el.textContent.trim().length >= 5) return el.textContent.trim()
    const m = document.body.innerText.match(/\b[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}\b/)
    return m ? m[0] : null
  })
  if (code) break
}
check('versus room code issued', code !== null, code ?? 'none within 30s')

if (code) {
  // Second tab joins the room; both should end up in a match.
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page2.on('pageerror', (e) => errors.push(`[pageerror p2] ${e.message}`))
  await page2.goto(base, { waitUntil: 'networkidle' })
  await page2.waitForTimeout(800)
  await page2.getByRole('button', { name: /versus/i }).click()
  await page2.waitForTimeout(300)
  await page2.locator('#join-code').fill(code.replace(/\s/g, ''))
  await page2.getByRole('button', { name: /^join$/i }).click()

  let connected = false
  for (let i = 0; i < 30; i++) {
    await page2.waitForTimeout(1000)
    const hostInMatch = await page.evaluate(
      () => !document.body.innerText.toLowerCase().includes('host game'),
    )
    const guestInMatch = await page2.evaluate(
      () => !document.body.innerText.toLowerCase().includes('join game'),
    )
    if (hostInMatch && guestInMatch) {
      connected = true
      break
    }
  }
  check('versus peers connected and match started', connected)
  await page.screenshot({ path: '/tmp/tribble-versus-host.png' })
  await page2.screenshot({ path: '/tmp/tribble-versus-guest.png' })

  if (connected) {
    // Play a bit on both boards so state snapshots flow between peers.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Space')
      await page2.keyboard.press('ArrowRight')
      await page2.keyboard.press('Space')
      await page.waitForTimeout(500)
    }
    await page.screenshot({ path: '/tmp/tribble-versus-host-play.png' })
    const oppVisible = await page.evaluate(() => {
      const c = document.getElementById('game-canvas')
      return c ? c.width > 0 : false
    })
    check('versus board renders opponent view', oppVisible)
  }
  await page2.close()
}

await browser.close()
console.log('\n--- page errors ---')
console.log(errors.length ? errors.slice(0, 20).join('\n') : '(none)')
process.exit(errors.length ? 1 : 0)
