import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@alfred/core': resolve('packages/core/src/index.ts'),
      '@alfred/providers': resolve('packages/providers/src/index.ts')
    }
  },
  test: {
    include: ['tests/**/*.integration.test.ts'],
    environment: 'node'
  }
})
