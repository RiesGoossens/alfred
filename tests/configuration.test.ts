import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseConfiguration } from '@alfred/core'

describe('ALFRED configuration', () => {
  it('uses the intended local defaults', () => {
    expect(parseConfiguration({})).toEqual({
      environment: 'development',
      ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'qwen3:8b',
        fallbackModel: 'qwen3:4b',
        timeoutMs: 5000,
        responseTimeoutMs: 60000
      },
      logging: {
        level: 'info'
      },
      database: {
        path: './data/alfred.sqlite'
      },
      voice: {
        speechToTextProvider: 'none',
        textToSpeechProvider: 'none'
      },
      personality: {
        override: {},
        responseLength: 'balanced'
      }
    })
  })

  it('accepts valid local overrides', () => {
    const configuration = parseConfiguration({
      ALFRED_ENV: 'test',
      ALFRED_OLLAMA_BASE_URL: 'http://localhost:11434',
      ALFRED_OLLAMA_MODEL: 'qwen3:4b',
      ALFRED_OLLAMA_FALLBACK_MODEL: 'qwen3:1.7b',
      ALFRED_OLLAMA_TIMEOUT_MS: '10000',
      ALFRED_OLLAMA_RESPONSE_TIMEOUT_MS: '30000',
      ALFRED_PERSONALITY_FILE: resolve('tests/fixtures/personality.override.json'),
      ALFRED_RESPONSE_LENGTH: 'detailed',
      ALFRED_EXTRA_INSTRUCTIONS: 'Use short, practical examples when useful.',
      ALFRED_LOG_LEVEL: 'debug',
      ALFRED_DATABASE_PATH: './data/test.sqlite',
      ALFRED_VOICE_STT_PROVIDER: 'whispercpp',
      ALFRED_VOICE_TTS_PROVIDER: 'piper'
    })

    expect(configuration.environment).toBe('test')
    expect(configuration.logging.level).toBe('debug')
    expect(configuration.ollama).toMatchObject({
      model: 'qwen3:4b',
      fallbackModel: 'qwen3:1.7b',
      timeoutMs: 10000,
      responseTimeoutMs: 30000
    })
    expect(configuration.voice).toEqual({
      speechToTextProvider: 'whispercpp',
      textToSpeechProvider: 'piper'
    })
    expect(configuration.personality).toEqual({
      override: {
        name: 'MILO',
        identity: ['You are MILO, a local assistant.'],
        traits: ['Be succinct.'],
        communicationStyle: ['Use plain language.']
      },
      responseLength: 'detailed',
      extraInstructions: 'Use short, practical examples when useful.'
    })
  })

  it.each([
    { ALFRED_OLLAMA_BASE_URL: 'not a url' },
    { ALFRED_OLLAMA_TIMEOUT_MS: 'not-a-number' },
    { ALFRED_OLLAMA_RESPONSE_TIMEOUT_MS: '500' },
    { ALFRED_RESPONSE_LENGTH: 'very-long' },
    { ALFRED_EXTRA_INSTRUCTIONS: '' },
    { ALFRED_PERSONALITY_INSTRUCTIONS: 'retired setting' },
    { ALFRED_SYSTEM_PROMPT: 'retired setting' },
    { ALFRED_LOG_LEVEL: 'verbose' },
    { ALFRED_VOICE_STT_PROVIDER: 'remote-service' },
    { ALFRED_VOICE_TTS_PROVIDER: 'cloud-voice' }
  ])('rejects invalid configuration values: %#', (environment) => {
    expect(() => parseConfiguration(environment)).toThrow()
  })

  it('reports clear errors for malformed and unreadable personality files', () => {
    expect(() =>
      parseConfiguration({
        ALFRED_PERSONALITY_FILE: resolve('tests/fixtures/personality.malformed.txt')
      })
    ).toThrow('not valid JSON')
    expect(() =>
      parseConfiguration({ ALFRED_PERSONALITY_FILE: './tests/fixtures/missing.json' })
    ).toThrow('could not be read')
  })
})
