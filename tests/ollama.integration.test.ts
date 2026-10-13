import { describe, expect, it } from 'vitest'

import { loadConfiguration } from '@alfred/core'
import { OllamaProvider } from '@alfred/providers'

describe('local Ollama integration', () => {
  const provider = new OllamaProvider(loadConfiguration().ollama)

  it('reaches the configured runtime and discovers its installed models', async () => {
    const health = await provider.healthCheck()
    expect(health.available).toBe(true)

    const discovery = await provider.discoverModels()
    expect(discovery.available).toBe(true)
    expect(discovery.models.length).toBeGreaterThan(0)
  })
})
