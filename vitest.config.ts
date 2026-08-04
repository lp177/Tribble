import { defineConfig } from 'vitest/config'

// Cap worker threads so the CPU-bound fuzz tests stay fast without thrashing a
// loaded machine (the default spawns one worker per core).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    maxWorkers: 4,
    minWorkers: 1,
  },
})
