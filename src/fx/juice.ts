// Game-feel effects: trauma-based screen shake, hit-stop, full-board flash.
// Pure state; the renderer reads offsetX/offsetY/rotation/flashAlpha, main.ts
// multiplies the simulation dt by timeScale. update(dt) expects REAL dt.

import type { Juice } from '../types'

/** Max shake displacement at full trauma, CSS pixels. */
const MAX_OFFSET = 10
/** Max shake rotation at full trauma, radians. */
const MAX_ROTATION = 0.035
/** Flash overlay starting alpha. */
const FLASH_ALPHA = 0.32
/** Alpha ceiling for flashes when reduced motion is on. */
const REDUCED_FLASH_ALPHA = 0.08
/** Ease-out time for timeScale to return to 1 after a hit-stop. */
const HIT_RECOVER_TIME = 0.05

/** Smooth pseudo-noise in [-1, 1]: two incommensurate sines, phase-offset per channel. */
function noise(t: number, phase: number): number {
  return Math.sin(t * 27.3 + phase) * 0.6 + Math.sin(t * 41.7 + phase * 1.31) * 0.4
}

export function createJuice(): Juice {
  let reduced = false

  let trauma = 0
  let traumaDecay = 2.4
  let noiseT = Math.random() * 100

  let offsetX = 0
  let offsetY = 0
  let rotation = 0

  let hitStopHold = 0
  let hitStopRecover = 0
  let timeScale = 1

  let flashAlpha = 0
  let flashColor = '#ffffff'
  let flashDecay = 0

  return {
    shake(intensity, duration) {
      if (reduced) return
      trauma = Math.min(1, trauma + intensity)
      // Exponential time constant so trauma is ~95% gone after `duration`.
      traumaDecay = 3 / Math.max(0.05, duration)
    },

    hitStop(duration) {
      if (reduced) return
      hitStopHold = Math.max(hitStopHold, duration)
      hitStopRecover = 0
      timeScale = 0
    },

    flash(color, duration) {
      flashColor = color
      flashAlpha = Math.max(flashAlpha, reduced ? REDUCED_FLASH_ALPHA : FLASH_ALPHA)
      flashDecay = flashAlpha / Math.max(0.01, duration)
    },

    update(dt) {
      noiseT += dt

      if (trauma > 0) {
        trauma *= Math.exp(-traumaDecay * dt)
        if (trauma < 0.004) trauma = 0
        const amt = trauma * trauma
        offsetX = amt * MAX_OFFSET * noise(noiseT, 0)
        offsetY = amt * MAX_OFFSET * noise(noiseT, 11.3)
        rotation = amt * MAX_ROTATION * noise(noiseT, 23.7)
      } else {
        offsetX = 0
        offsetY = 0
        rotation = 0
      }

      if (hitStopHold > 0) {
        hitStopHold -= dt
        if (hitStopHold <= 0) {
          hitStopHold = 0
          hitStopRecover = HIT_RECOVER_TIME
        } else {
          timeScale = 0
        }
      }
      if (hitStopRecover > 0) {
        hitStopRecover = Math.max(0, hitStopRecover - dt)
        const p = 1 - hitStopRecover / HIT_RECOVER_TIME
        timeScale = 1 - (1 - p) * (1 - p)
      } else if (hitStopHold === 0) {
        timeScale = 1
      }

      if (flashAlpha > 0) {
        flashAlpha = Math.max(0, flashAlpha - flashDecay * dt)
      }
    },

    get offsetX() {
      return offsetX
    },
    get offsetY() {
      return offsetY
    },
    get rotation() {
      return rotation
    },
    get timeScale() {
      return timeScale
    },
    get flashAlpha() {
      return flashAlpha
    },
    get flashColor() {
      return flashColor
    },

    setReducedMotion(on) {
      reduced = on
      if (on) {
        trauma = 0
        offsetX = 0
        offsetY = 0
        rotation = 0
        hitStopHold = 0
        hitStopRecover = 0
        timeScale = 1
        flashAlpha = Math.min(flashAlpha, REDUCED_FLASH_ALPHA)
      }
    },
  }
}
