// Headless smoke test: boots the built game, walks the menus, plays a few
// launches, and reports console errors + screenshots.
// Usage: node scripts/smoke.mjs [baseUrl] [outDir]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const base = process.argv[2] ?? 'http://localhost:4173/'
const out = process.argv[3] ?? '/tmp/tribble-smoke'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`)
})
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`))

const step = async (name, fn) => {
  try {
    await fn()
    await page.screenshot({ path: `${out}/${name}.png` })
    console.log(`ok   ${name}`)
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`)
    await page.screenshot({ path: `${out}/${name}-FAIL.png` }).catch(() => {})
  }
}

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForTimeout(900)

await step('01-title', async () => {
  await page.waitForSelector('text=/tribble/i', { timeout: 5000 })
})

await step('02-howto', async () => {
  await page.getByRole('button', { name: /how to play/i }).click()
  await page.waitForTimeout(400)
})

await step('03-settings', async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^settings$/i }).click()
  await page.waitForTimeout(400)
})

await step('04-versus-lobby', async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /versus/i }).click()
  await page.waitForTimeout(500)
})

await step('05-newgame', async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /new game/i }).click()
  await page.waitForTimeout(1200)
})

await step('06-play', async () => {
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press(i % 3 === 0 ? 'ArrowUp' : i % 3 === 1 ? 'ArrowLeft' : 'ArrowRight')
    await page.keyboard.press('Space')
    await page.waitForTimeout(650)
  }
})

await step('07-pause', async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
})

// Verify a save was written, then reload and check Resume appears.
const saved = await page.evaluate(() => localStorage.getItem('tribble.save.v1') !== null)
console.log(`save written: ${saved}`)

await step('08-resume-after-reload', async () => {
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const resume = page.getByRole('button', { name: /resume/i })
  if (!(await resume.isVisible())) throw new Error('Resume button not visible after reload')
  await resume.click()
  await page.waitForTimeout(1200)
})

const score = await page.evaluate(() => {
  const el = document.querySelector('[data-hud-score], .hud-score, #score')
  return el ? el.textContent : null
})
console.log(`hud score element: ${score}`)

await browser.close()

console.log('\n--- console errors/warnings ---')
if (errors.length === 0) console.log('(none)')
else for (const e of errors.slice(0, 40)) console.log(e)
console.log(`\nscreenshots: ${out}`)
process.exit(errors.some((e) => e.startsWith('[pageerror]') || e.startsWith('[error]')) ? 1 : 0)
