import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const currentDirectory = fileURLToPath(new URL('.', import.meta.url))
const coreEntryPoint = resolve(currentDirectory, '../../packages/core/src/index.ts')
const providersEntryPoint = resolve(currentDirectory, '../../packages/providers/src/index.ts')
const toolsEntryPoint = resolve(currentDirectory, '../../packages/tools/src/index.ts')

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: ['@alfred/core', '@alfred/providers', '@alfred/tools'] })
    ],
    resolve: {
      alias: {
        '@alfred/core': coreEntryPoint,
        '@alfred/providers': providersEntryPoint,
        '@alfred/tools': toolsEntryPoint
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
})
