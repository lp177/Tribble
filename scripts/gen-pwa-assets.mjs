// Generates the web app manifest and its icons into public/.
//
// The game ships no art files, so the icons are drawn here in code and encoded
// as PNG with nothing but Node's zlib — a manifest needs real raster icons, and
// this keeps that true without adding a dependency or a binary blob nobody can
// diff. Deterministic: same input, same bytes, so re-running is a no-op in git.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(ROOT, 'public')

// -- PNG encoding ------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** rgba: Uint8Array of size w*h*4. */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10..12 = compression, filter, interlace — all 0

  // Filter byte 0 (None) per scanline.
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    const dst = y * (1 + w * 4)
    raw[dst] = 0
    rgba.copy
      ? Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, dst + 1)
      : raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), dst + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// -- Icon artwork ------------------------------------------------------------

const BG = [0x12, 0x12, 0x1a]
const BLOCKS = [
  [0xff, 0x5c, 0x8a],
  [0xff, 0xd1, 0x66],
  [0x06, 0xd6, 0xa0],
  [0x4c, 0xc9, 0xf0],
]

/**
 * A 2x2 tetromino — the piece sitting on the launcher — on the app's dark
 * background. `inset` reserves the safe area a maskable icon needs.
 */
function drawIcon(size, inset) {
  const px = new Uint8Array(size * size * 4)
  const put = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    // Simple source-over so the rounded edges can anti-alias.
    const ia = a / 255
    px[i] = px[i] * (1 - ia) + r * ia
    px[i + 1] = px[i + 1] * (1 - ia) + g * ia
    px[i + 2] = px[i + 2] * (1 - ia) + b * ia
    px[i + 3] = Math.max(px[i + 3], a)
  }

  // Background: full bleed, so a maskable crop never shows transparency.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, BG)

  const area = size * (1 - inset * 2)
  const origin = size * inset
  const gap = area * 0.06
  const cell = (area - gap) / 2
  const radius = cell * 0.22

  const coverage = (x, y, bx, by) => {
    // Distance-to-rounded-rect, sampled at pixel centre for a soft edge.
    const cx = Math.max(bx + radius, Math.min(x + 0.5, bx + cell - radius))
    const cy = Math.max(by + radius, Math.min(y + 0.5, by + cell - radius))
    const dx = x + 0.5 - cx
    const dy = y + 0.5 - cy
    const d = Math.hypot(dx, dy) - radius
    return Math.max(0, Math.min(1, 0.5 - d))
  }

  for (let i = 0; i < 4; i++) {
    const bx = origin + (i % 2) * (cell + gap)
    const by = origin + Math.floor(i / 2) * (cell + gap)
    const colour = BLOCKS[i]
    const x0 = Math.floor(bx) - 1
    const y0 = Math.floor(by) - 1
    const x1 = Math.ceil(bx + cell) + 1
    const y1 = Math.ceil(by + cell) + 1
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const a = coverage(x, y, bx, by)
        if (a > 0) put(x, y, colour, Math.round(a * 255))
      }
    }
    // Top bevel, matching the in-game block treatment.
    for (let y = Math.floor(by + cell * 0.08); y < by + cell * 0.24; y++) {
      for (let x = Math.floor(bx + cell * 0.16); x < bx + cell * 0.84; x++) {
        const a = coverage(x, y, bx, by)
        if (a > 0) put(x, y, [255, 255, 255], Math.round(a * 46))
      }
    }
  }

  return Buffer.from(px.buffer, px.byteOffset, px.length)
}

// -- Emit --------------------------------------------------------------------

mkdirSync(PUBLIC, { recursive: true })

const ICONS = [
  { file: 'icon-192.png', size: 192, inset: 0.12, purpose: 'any' },
  { file: 'icon-512.png', size: 512, inset: 0.12, purpose: 'any' },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.22, purpose: 'maskable' },
]

for (const icon of ICONS) {
  const rgba = drawIcon(icon.size, icon.inset)
  writeFileSync(join(PUBLIC, icon.file), encodePng(icon.size, icon.size, rgba))
}

const manifest = {
  name: 'Tribble',
  short_name: 'Tribble',
  description:
    'A Tetris x bubble-shooter hybrid. Aim, rotate and launch pieces, clear lines and colour matches before the stack reaches the top.',
  // Relative so the app works from a GitHub Pages project path.
  start_url: './',
  scope: './',
  id: './',
  display: 'standalone',
  background_color: '#0f0f17',
  theme_color: '#12121a',
  categories: ['games'],
  icons: ICONS.map((i) => ({
    src: `./${i.file}`,
    sizes: `${i.size}x${i.size}`,
    type: 'image/png',
    purpose: i.purpose,
  })),
}

writeFileSync(join(PUBLIC, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`pwa assets: ${ICONS.map((i) => i.file).join(', ')}, manifest.webmanifest`)
