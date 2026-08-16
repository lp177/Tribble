// Post-build step: emits docs/sw.js from src/pwa/service-worker.js with the
// real precache list and a build id derived from the built bytes.
//
// The build id is what drives updates: it changes only when the output changes,
// so sw.js is byte-identical across rebuilds of identical source and the
// browser correctly reports "no update".
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs')

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}

const files = walk(OUT)
  .map((f) => relative(OUT, f).split('\\').join('/'))
  .filter((f) => f !== 'sw.js')
  .sort()

// Precache the shell and everything needed to render it offline. Icons are
// included so an installed app has them without a network round trip.
const precache = [
  './index.html',
  './manifest.webmanifest',
  // ...but not social-card.png: that is the Open Graph preview, fetched by
  // crawlers and never by the game, and the .png sweep below would otherwise
  // drag ~700KB into every offline install.
  ...files.filter((f) => f !== 'social-card.png'
    && (f.startsWith('assets/') || f.endsWith('.png'))),
].map((f) => (f.startsWith('./') ? f : `./${f}`))

const hash = createHash('sha256')
for (const f of files) {
  hash.update(f)
  hash.update(readFileSync(join(OUT, f)))
}
const buildId = hash.digest('hex').slice(0, 12)

const template = readFileSync(join(ROOT, 'src/pwa/service-worker.js'), 'utf8')
const sw = template
  .replace('__BUILD_ID__', buildId)
  .replace('__PRECACHE__', JSON.stringify(precache, null, 2))

if (sw.includes('__BUILD_ID__') || sw.includes('__PRECACHE__')) {
  throw new Error('service worker template placeholders were not replaced')
}

writeFileSync(join(OUT, 'sw.js'), sw)
console.log(`sw.js: build ${buildId}, ${precache.length} precached entries`)
