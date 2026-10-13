import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@alfred/core': resolve('packages/core/src/index.ts'),
      '@alfred/providers': resolve('packages/providers/src/index.ts'),
      '@alfred/tools': resolve('packages/tools/src/index.ts'),
      '@alfred/voice': resolve('packages/voice/src/index.ts')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.integration.test.ts'],
    environment: 'node'
  }
})
