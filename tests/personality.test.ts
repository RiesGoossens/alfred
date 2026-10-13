import { describe, expect, it } from 'vitest'

import {
  buildSystemPrompt,
  createPersonality,
  defaultPersonality,
  parseConfiguration,
  personalityOverrideSchema
} from '@alfred/core'
import { resolve } from 'node:path'

describe('ALFRED personality system', () => {
  it('provides a valid default personality', () => {
    expect(defaultPersonality.identity.join(' ')).toContain(
      "Altijd Luisterend, Fikst Rotzooi, En Doet 't"
    )
  })

  it('builds a deterministic, structured default system prompt', () => {
    const prompt = buildSystemPrompt(createPersonality({}))

    expect(buildSystemPrompt(createPersonality({}))).toBe(prompt)
    expect(prompt).toContain('## Identity')
    expect(prompt).toContain('## Personality')
    expect(prompt).toContain('## Communication style')
    expect(prompt).toContain('## Current capabilities')
    expect(prompt).toContain('## Planned capabilities (NOT available yet)')
    expect(prompt).toContain('## Behavioral constraints')
    expect(prompt).toContain(
      "Respond in the user's language unless they request a different language."
    )
    expect(prompt).toContain('Do not claim to have tools')
    expect(prompt).toContain('computer control')
    expect(prompt).toContain('You can have a local, session-only text conversation')
    expect(prompt).not.toContain('C:\\')
    expect(prompt).not.toContain('Conversation history')
  })

  it('loads a Zod-validated personality override without changing application-owned sections', () => {
    const configuration = parseConfiguration({
      ALFRED_PERSONALITY_FILE: resolve('tests/fixtures/personality.override.json')
    })
    const prompt = buildSystemPrompt(createPersonality(configuration.personality))

    expect(prompt).toContain('You are MILO, a local assistant.')
    expect(prompt).toContain('Be succinct.')
    expect(prompt).toContain('Use plain language.')
    expect(prompt).toContain('You can have a local, session-only text conversation')
    expect(prompt).toContain('Persistent memory between sessions.')
    expect(prompt).toContain('Never state that an action was performed')
  })

  it('rejects invalid personality overrides and capability replacement attempts', () => {
    expect(() => personalityOverrideSchema.parse({ traits: [] })).toThrow()
    expect(() =>
      personalityOverrideSchema.parse({ currentCapabilities: ['Open every application.'] })
    ).toThrow()
    expect(() =>
      parseConfiguration({
        ALFRED_PERSONALITY_FILE: resolve('tests/fixtures/personality.invalid.json')
      })
    ).toThrow()
  })

  it('appends extra instructions without replacing the core sections', () => {
    const prompt = buildSystemPrompt(
      createPersonality(
        parseConfiguration({
          ALFRED_EXTRA_INSTRUCTIONS: 'Use metric units when measurements are requested.'
        }).personality
      )
    )

    expect(prompt).toContain('## Extra instructions')
    expect(prompt).toContain('Use metric units when measurements are requested.')
    expect(prompt).toContain('## Current capabilities')
    expect(prompt).toContain('## Behavioral constraints')
  })

  it.each([
    ['concise', 'Keep responses focused and brief'],
    ['balanced', 'Match the response length to the request'],
    ['detailed', 'Provide thorough explanations when useful']
  ] as const)('uses the %s response-length guidance', (responseLength, expectedInstruction) => {
    const prompt = buildSystemPrompt(
      createPersonality(parseConfiguration({ ALFRED_RESPONSE_LENGTH: responseLength }).personality)
    )

    expect(prompt).toContain(expectedInstruction)
  })
})
