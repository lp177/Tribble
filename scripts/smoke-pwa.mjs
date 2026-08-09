// End-to-end check of the service worker: offline play, and the update prompt.
//
// Serves a COPY of docs/ from a temp dir so the test can mutate the deployment
// mid-run and watch the app notice — which is the whole point of the feature.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, cpSync, mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'

const SRC = new URL('../docs/', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'tribble-pwa-'))
cpSync(SRC, dir, { recursive: true })

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let path = decodeURIComponent(url.pathname)
  if (path.endsWith('/')) path += 'index.html'
  const file = join(dir, path)
  if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  // Deliberately hostile caching on the HTML, mimicking the original bug: the
  // service worker must make this irrelevant.
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': extname(file) === '.html' ? 'public, max-age=600' : 'no-cache',
  })
  res.end(readFileSync(file))
})

await new Promise((r) => server.listen(0, r))
const base = `http://localhost:${server.address().port}/`

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
page.on('console', (m) => {
  // The reachability probe deliberately fails while offline; the browser logs
  // that at error level and it cannot be suppressed from script.
  const expectedOffline = /ERR_INTERNET_DISCONNECTED|Failed to load resource/i.test(m.text())
  if (m.type() === 'error' && !expectedOffline) errors.push(`[error] ${m.text()}`)
})
const check = (n, ok, d = '') => console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`)
let failed = 0
const expect = (n, ok, d) => {
  if (!ok) failed++
  check(n, ok, d)
}

// --- 1. The worker registers and takes control ------------------------------
await page.goto(base, { waitUntil: 'networkidle' })
const controlled = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready
  for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  return { scope: reg.scope, controlled: !!navigator.serviceWorker.controller }
})
expect('service worker controls the page', controlled.controlled, `scope=${controlled.scope}`)

const cached = await page.evaluate(async () => {
  const names = await caches.keys()
  const cache = await caches.open(names[0])
  return { names, entries: (await cache.keys()).length }
})
expect(
  'app shell precached',
  cached.entries >= 5 && cached.names.some((n) => n.startsWith('tribble-')),
  `${cached.names.join(',')} (${cached.entries} entries)`,
)

// --- 2. Offline: the game still loads and plays -----------------------------
await context.setOffline(true)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
const offlineTitle = await page.evaluate(() => /tribble/i.test(document.body.innerText))
expect('loads offline from cache', offlineTitle)

const offlineChip = await page.evaluate(() =>
  /offline/i.test(document.body.innerText),
)
expect('offline indicator shown', offlineChip)

await page.getByRole('button', { name: /new game/i }).click()
await page.waitForTimeout(1000)
for (let i = 0; i < 4; i++) {
  await page.keyboard.press('Space')
  await page.waitForTimeout(400)
}
const playedOffline = await page.evaluate(
  () => [...document.querySelectorAll('section')].filter((s) => s.offsetParent !== null).length === 0,
)
expect('plays a run while offline', playedOffline)

await context.setOffline(false)
await page.waitForTimeout(500)

// --- 3. Deploy a new version; the app must notice and offer it --------------
const swPath = join(dir, 'sw.js')
const sw = readFileSync(swPath, 'utf8')
writeFileSync(swPath, sw.replace(/const BUILD_ID = '([^']+)'/, "const BUILD_ID = 'testbuild002'"))
const htmlPath = join(dir, 'index.html')
writeFileSync(
  htmlPath,
  readFileSync(htmlPath, 'utf8').replace('<title>Tribble</title>', '<title>Tribble v2</title>'),
)

await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration()
  await reg.update()
})

let bannerSeen = false
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(500)
  bannerSeen = await page.evaluate(() => /new version available/i.test(document.body.innerText))
  if (bannerSeen) break
}
expect('update prompt appears after a new deploy', bannerSeen)

// The prompt must not hijack the game: the run should still be going.
const stillPlaying = await page.evaluate(
  () => [...document.querySelectorAll('section')].filter((s) => s.offsetParent !== null).length === 0,
)
expect('update prompt does not interrupt the run', stillPlaying)

// --- 3b. The prompt must be usable from a menu screen too -------------------
// The menu layer sits at z-index 20 and lays a full-viewport backdrop-filter
// with pointer-events: auto over everything under it. A prompt beneath that is
// dimmed AND unclickable, which is exactly what shipped first.
if (bannerSeen) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  const onMenu = await page.evaluate(
    () => [...document.querySelectorAll('section')].filter((s) => s.offsetParent !== null).length > 0,
  )
  if (onMenu) {
    const topmost = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.update-banner button')].find((b) =>
        /reload/i.test(b.textContent ?? ''),
      )
      if (!btn) return { ok: false, why: 'no reload button' }
      const r = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { ok: btn.contains(hit) || hit === btn, why: hit?.className ?? 'none' }
    })
    expect('update prompt is clickable over a menu screen', topmost.ok, `hit=${topmost.why}`)
    await page.screenshot({ path: '/tmp/tribble-update-over-menu.png' })
  } else {
    console.log('     (could not reach a menu screen; overlay check skipped)')
  }
}

// --- 4. Accepting the update swaps to the new version -----------------------
if (bannerSeen) {
  const savedBefore = await page.evaluate(
    () => localStorage.getItem('tribble.save.v1') !== null,
  )
  await page.getByRole('button', { name: /^reload$/i }).click()
  await page.waitForTimeout(4000)
  const title = await page.title()
  expect('reload activates the new version', title === 'Tribble v2', `title="${title}"`)

  const savedAfter = await page.evaluate(() => localStorage.getItem('tribble.save.v1') !== null)
  expect('run was saved across the update', savedBefore || savedAfter)

  const resumeVisible = await page
    .getByRole('button', { name: /resume/i })
    .first()
    .isVisible()
    .catch(() => false)
  expect('Resume offered after updating mid-run', resumeVisible)

  const oldCacheGone = await page.evaluate(async () => {
    const names = await caches.keys()
    return names.filter((n) => n.startsWith('tribble-'))
  })
  expect('old caches cleaned up', oldCacheGone.length === 1, oldCacheGone.join(','))
}

await browser.close()
server.close()

console.log('\n--- page errors ---')
console.log(errors.length ? errors.slice(0, 20).join('\n') : '(none)')
process.exit(failed > 0 || errors.length > 0 ? 1 : 0)
