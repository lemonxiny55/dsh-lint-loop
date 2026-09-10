import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false, // TS6+ DTS build bug — see dsh-code-index; consumers use the plugin surface, not types
  sourcemap: true,
  clean: true,
  target: 'node22',
})
