import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
    // The suite spawns fake linters as child processes; give each test a
    // generous budget so CI cold starts and first-spawn latency never flake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
