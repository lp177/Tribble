// Fixed-pool particle system, screen-space CSS pixels. All storage is
// preallocated (parallel typed arrays + a free-list); spawn/update never
// allocate. Kinds: shard (rotated squares, gravity), spark (additive dots),
// trail (soft dot for the flying piece), floatText (separate small pool).

import type { ParticleBurstOpts, ParticleSystem } from '../types'

const POOL_SIZE = 800
const TEXT_POOL_SIZE = 32
const TAU = Math.PI * 2

const K_SHARD = 0
const K_SPARK = 1
const K_TRAIL = 2

const TEXT_BASE_SIZE = 16
const TEXT_FONT = `700 ${TEXT_BASE_SIZE}px system-ui, sans-serif`
const TEXT_RISE = 40
const TEXT_POP_TIME = 0.18
const TEXT_LIFE = 1.0

const BURST_DEFAULTS = {
  count: 16,
  speed: 170,
  spread: TAU,
  gravity: 600,
  life: 0.7,
  size: 7,
} as const

function easeOutBack(t: number): number {
  const c1 = 1.70158
  const p = t - 1
  return 1 + (c1 + 1) * p * p * p + c1 * p * p
}

export function createParticles(): ParticleSystem {
  let reduced = false
  let trailSkip = 0
  let textCursor = 0

  // Main pool (shard / spark / trail).
  const alive = new Uint8Array(POOL_SIZE)
  const kind = new Uint8Array(POOL_SIZE)
  const px = new Float32Array(POOL_SIZE)
  const py = new Float32Array(POOL_SIZE)
  const vx = new Float32Array(POOL_SIZE)
  const vy = new Float32Array(POOL_SIZE)
  const life = new Float32Array(POOL_SIZE)
  const maxLife = new Float32Array(POOL_SIZE)
  const size = new Float32Array(POOL_SIZE)
  const rot = new Float32Array(POOL_SIZE)
  const rotV = new Float32Array(POOL_SIZE)
  const grav = new Float32Array(POOL_SIZE)
  const color: string[] = new Array<string>(POOL_SIZE).fill('')

  const freeList = new Int32Array(POOL_SIZE)
  let freeTop = POOL_SIZE
  for (let i = 0; i < POOL_SIZE; i++) freeList[i] = POOL_SIZE - 1 - i

  // Float-text pool.
  const tAlive = new Uint8Array(TEXT_POOL_SIZE)
  const tX = new Float32Array(TEXT_POOL_SIZE)
  const tY = new Float32Array(TEXT_POOL_SIZE)
  const tAge = new Float32Array(TEXT_POOL_SIZE)
  const tSize = new Float32Array(TEXT_POOL_SIZE)
  const tText: string[] = new Array<string>(TEXT_POOL_SIZE).fill('')
  const tColor: string[] = new Array<string>(TEXT_POOL_SIZE).fill('')

  function kill(i: number): void {
    alive[i] = 0
    freeList[freeTop++] = i
  }

  /** Pops a free slot, or -1 when the pool is exhausted (spawn is dropped). */
  function spawn(
    k: number,
    x: number,
    y: number,
    velX: number,
    velY: number,
    lifeS: number,
    sizePx: number,
    gravity: number,
    col: string,
  ): number {
    if (freeTop === 0) return -1
    const i = freeList[--freeTop]
    alive[i] = 1
    kind[i] = k
    px[i] = x
    py[i] = y
    vx[i] = velX
    vy[i] = velY
    life[i] = lifeS
    maxLife[i] = lifeS
    size[i] = sizePx
    rot[i] = 0
    rotV[i] = 0
    grav[i] = gravity
    color[i] = col
    return i
  }

  return {
    burst(x, y, col, opts?: ParticleBurstOpts) {
      let count = opts?.count ?? BURST_DEFAULTS.count
      const speed = opts?.speed ?? BURST_DEFAULTS.speed
      const spread = opts?.spread ?? BURST_DEFAULTS.spread
      const gravity = opts?.gravity ?? BURST_DEFAULTS.gravity
      const lifeS = opts?.life ?? BURST_DEFAULTS.life
      const sizePx = opts?.size ?? BURST_DEFAULTS.size
      if (reduced) count = Math.max(1, Math.round(count * 0.25))

      const fullCircle = spread >= TAU - 1e-3
      for (let n = 0; n < count; n++) {
        const angle = fullCircle
          ? Math.random() * TAU
          : -Math.PI / 2 + (Math.random() - 0.5) * spread
        const isSpark = n % 3 === 2
        const v = speed * (0.35 + Math.random() * 0.85) * (isSpark ? 1.3 : 1)
        const velX = Math.cos(angle) * v
        const velY = Math.sin(angle) * v
        if (isSpark) {
          spawn(K_SPARK, x, y, velX, velY, lifeS * 0.55, 2.2, 0, col)
        } else {
          const i = spawn(
            K_SHARD,
            x,
            y,
            velX,
            velY,
            lifeS * (0.7 + Math.random() * 0.5),
            sizePx * (0.6 + Math.random() * 0.8),
            gravity,
            col,
          )
          if (i >= 0) {
            rot[i] = Math.random() * TAU
            rotV[i] = (Math.random() - 0.5) * 12
          }
        }
      }
    },

    trail(x, y, col) {
      if (reduced) {
        // Spawn-count x0.25: emit on every 4th call only.
        trailSkip = (trailSkip + 1) & 3
        if (trailSkip !== 0) return
      }
      spawn(
        K_TRAIL,
        x,
        y,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        0.28,
        5.5,
        0,
        col,
      )
    },

    floatText(x, y, text, opts) {
      let slot = -1
      for (let j = 0; j < TEXT_POOL_SIZE; j++) {
        if (!tAlive[j]) {
          slot = j
          break
        }
      }
      if (slot < 0) {
        // Pool full: recycle round-robin so new information always shows.
        slot = textCursor % TEXT_POOL_SIZE
        textCursor++
      }
      tAlive[slot] = 1
      tX[slot] = x
      tY[slot] = y
      tAge[slot] = 0
      tSize[slot] = opts?.size ?? TEXT_BASE_SIZE
      tText[slot] = text
      tColor[slot] = opts?.color ?? '#ffffff'
    },

    update(dt) {
      for (let i = 0; i < POOL_SIZE; i++) {
        if (!alive[i]) continue
        life[i] -= dt
        if (life[i] <= 0) {
          kill(i)
          continue
        }
        vy[i] += grav[i] * dt
        px[i] += vx[i] * dt
        py[i] += vy[i] * dt
        rot[i] += rotV[i] * dt
      }
      for (let j = 0; j < TEXT_POOL_SIZE; j++) {
        if (!tAlive[j]) continue
        tAge[j] += dt
        if (tAge[j] >= TEXT_LIFE) tAlive[j] = 0
      }
    },

    render(ctx) {
      // Trails first (under everything).
      for (let i = 0; i < POOL_SIZE; i++) {
        if (!alive[i] || kind[i] !== K_TRAIL) continue
        const f = life[i] / maxLife[i]
        const r = size[i] * (0.4 + 0.6 * f)
        ctx.fillStyle = color[i]
        ctx.globalAlpha = 0.28 * f
        ctx.beginPath()
        ctx.arc(px[i], py[i], r, 0, TAU)
        ctx.fill()
        ctx.globalAlpha = 0.55 * f
        ctx.beginPath()
        ctx.arc(px[i], py[i], r * 0.45, 0, TAU)
        ctx.fill()
      }

      // Shards: rotated squares, shrink + fade.
      for (let i = 0; i < POOL_SIZE; i++) {
        if (!alive[i] || kind[i] !== K_SHARD) continue
        const f = life[i] / maxLife[i]
        const h = size[i] * 0.5 * (0.35 + 0.65 * f)
        const c = Math.cos(rot[i])
        const s = Math.sin(rot[i])
        const ax = h * (c - s)
        const ay = h * (s + c)
        const bx = h * (c + s)
        const by = h * (s - c)
        const x = px[i]
        const y = py[i]
        ctx.fillStyle = color[i]
        ctx.globalAlpha = Math.min(1, f * 1.3)
        ctx.beginPath()
        ctx.moveTo(x + ax, y + ay)
        ctx.lineTo(x + bx, y + by)
        ctx.lineTo(x - ax, y - ay)
        ctx.lineTo(x - bx, y - by)
        ctx.closePath()
        ctx.fill()
      }

      // Sparks: additive tiny dots (plain blending under reduced motion).
      if (!reduced) ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < POOL_SIZE; i++) {
        if (!alive[i] || kind[i] !== K_SPARK) continue
        const f = life[i] / maxLife[i]
        ctx.fillStyle = color[i]
        ctx.globalAlpha = f * f
        ctx.beginPath()
        ctx.arc(px[i], py[i], size[i] * (0.5 + 0.5 * f), 0, TAU)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'

      // Float text on top; always shown (it is information).
      let textReady = false
      for (let j = 0; j < TEXT_POOL_SIZE; j++) {
        if (!tAlive[j]) continue
        if (!textReady) {
          ctx.font = TEXT_FONT
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.lineJoin = 'round'
          ctx.lineWidth = 3
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
          textReady = true
        }
        const p = tAge[j] / TEXT_LIFE
        const inv = 1 - p
        const rise = TEXT_RISE * (1 - inv * inv)
        const pop = easeOutBack(Math.min(1, (tAge[j] + 0.02) / TEXT_POP_TIME))
        const k = (tSize[j] / TEXT_BASE_SIZE) * pop
        ctx.globalAlpha = p < 0.55 ? 1 : inv / 0.45
        ctx.save()
        ctx.translate(tX[j], tY[j] - rise)
        ctx.scale(k, k)
        ctx.strokeText(tText[j], 0, 0)
        ctx.fillStyle = tColor[j]
        ctx.fillText(tText[j], 0, 0)
        ctx.restore()
      }

      ctx.globalAlpha = 1
    },

    clear() {
      alive.fill(0)
      tAlive.fill(0)
      freeTop = POOL_SIZE
      for (let i = 0; i < POOL_SIZE; i++) freeList[i] = POOL_SIZE - 1 - i
      trailSkip = 0
      textCursor = 0
    },

    setReducedMotion(on) {
      reduced = on
    },
  }
}
