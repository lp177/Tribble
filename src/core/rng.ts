import type { Rng } from '../types'

/**
 * mulberry32: a fast 32-bit PRNG whose whole state is a single uint32, which
 * makes a game trivially serializable and resumable with an identical stream.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int(n: number): number {
      if (!(n > 0)) return 0
      return Math.floor(next() * n)
    },
    pick<T>(arr: readonly T[]): T {
      return arr[Math.floor(next() * arr.length)]
    },
    getState(): number {
      return state
    },
    setState(s: number): void {
      state = s >>> 0
    },
  }
}
