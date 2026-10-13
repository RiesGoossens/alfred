import { config as loadDotenv } from 'dotenv'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import { personalityConfigurationSchema, personalityOverrideSchema } from './personality.js'

const logLevels = ['debug', 'info', 'warn', 'error'] as const
const environments = ['development', 'test', 'production'] as const
const speechToTextProviders = ['none', 'whispercpp'] as const
const textToSpeechProviders = ['none', 'piper'] as const

export const configurationSchema = z
  .object({
    ALFRED_ENV: z.enum(environments).default('development'),
    ALFRED_OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
    ALFRED_OLLAMA_MODEL: z.string().trim().min(1).default('qwen3:8b'),
    ALFRED_OLLAMA_FALLBACK_MODEL: z.string().trim().min(1).default('qwen3:4b'),
    ALFRED_OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(5000),
    ALFRED_OLLAMA_RESPONSE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
    ALFRED_PERSONALITY_FILE: z.string().trim().min(1).optional(),
    ALFRED_RESPONSE_LENGTH: z.enum(['concise', 'balanced', 'detailed']).default('balanced'),
    ALFRED_EXTRA_INSTRUCTIONS: z.string().trim().min(1).max(4000).optional(),
    ALFRED_PERSONALITY_INSTRUCTIONS: z.undefined().optional(),
    ALFRED_SYSTEM_PROMPT: z.undefined().optional(),
    ALFRED_LOG_LEVEL: z.enum(logLevels).default('info'),
    ALFRED_DATABASE_PATH: z.string().trim().min(1).default('./data/alfred.sqlite'),
    ALFRED_VOICE_STT_PROVIDER: z.enum(speechToTextProviders).default('none'),
    ALFRED_VOICE_TTS_PROVIDER: z.enum(textToSpeechProviders).default('none')
  })
  .transform((values) => ({
    environment: values.ALFRED_ENV,
    ollama: {
      baseUrl: values.ALFRED_OLLAMA_BASE_URL,
      model: values.ALFRED_OLLAMA_MODEL,
      fallbackModel: values.ALFRED_OLLAMA_FALLBACK_MODEL,
      timeoutMs: values.ALFRED_OLLAMA_TIMEOUT_MS,
      responseTimeoutMs: values.ALFRED_OLLAMA_RESPONSE_TIMEOUT_MS
    },
    logging: {
      level: values.ALFRED_LOG_LEVEL
    },
    database: {
      path: values.ALFRED_DATABASE_PATH
    },
    voice: {
      speechToTextProvider: values.ALFRED_VOICE_STT_PROVIDER,
      textToSpeechProvider: values.ALFRED_VOICE_TTS_PROVIDER
    },
    personality: personalityConfigurationSchema.parse({
      override: loadPersonalityOverride(values.ALFRED_PERSONALITY_FILE),
      responseLength: values.ALFRED_RESPONSE_LENGTH,
      extraInstructions: values.ALFRED_EXTRA_INSTRUCTIONS
    })
  }))

export type AlfredConfiguration = z.infer<typeof configurationSchema>
export type OllamaConfiguration = AlfredConfiguration['ollama']

export function parseConfiguration(
  environment: Record<string, string | undefined>
): AlfredConfiguration {
  return configurationSchema.parse(environment)
}

function loadPersonalityOverride(filePath: string | undefined) {
  if (filePath === undefined) return {}

  const resolvedPath = resolve(filePath)
  let parsed: unknown

  try {
    parsed = JSON.parse(readFileSync(resolvedPath, 'utf8'))
  } catch (error) {
    const detail = error instanceof SyntaxError ? 'not valid JSON' : 'could not be read'
    throw new Error(`Personality file "${filePath}" ${detail}.`, { cause: error })
  }

  return personalityOverrideSchema.parse(parsed)
}

export function loadLocalEnvironment(workingDirectory = process.cwd()): void {
  loadDotenv({ path: join(workingDirectory, '.env.local') })
}

export function loadConfiguration(): AlfredConfiguration {
  loadLocalEnvironment()
  return parseConfiguration(process.env)
}
