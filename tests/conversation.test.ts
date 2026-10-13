import pino from 'pino'
import { describe, expect, it } from 'vitest'

import {
  ConversationEngine,
  buildSystemPrompt,
  createPersonality,
  LlmRequestError,
  parseConfiguration,
  type LlmChatRequest,
  type LlmModelDiscovery,
  type LlmProvider,
  type LlmProviderHealth,
  type LlmStreamChunk
} from '@alfred/core'

const configuration = parseConfiguration({})
const silentLogger = pino({ enabled: false })

describe('ConversationEngine', () => {
  it('starts with the configured system message and streams a completed response', async () => {
    const provider = new FakeProvider(['Hello there'])
    const engine = new ConversationEngine(provider, configuration, silentLogger)

    const events = await collect(engine.sendMessage('Hi'))

    const chunks = events.filter((event) => event.type === 'assistant-delta')
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((event) => event.content).join('')).toBe('Hello there')
    expect(engine.getMessages().map((message) => [message.role, message.content])).toEqual([
      ['system', buildSystemPrompt(createPersonality(configuration.personality))],
      ['user', 'Hi'],
      ['assistant', 'Hello there']
    ])
    expect(provider.requests[0]?.messages[0]?.role).toBe('system')
  })

  it('keeps prior turns in the next model request', async () => {
    const provider = new FakeProvider(['Paris.', 'About two million people.'])
    const engine = new ConversationEngine(provider, configuration, silentLogger)

    await collect(engine.sendMessage('What is the capital of France?'))
    await collect(engine.sendMessage('How many people live there?'))

    expect(provider.requests[1]?.messages.map((message) => message.content)).toEqual([
      buildSystemPrompt(createPersonality(configuration.personality)),
      'What is the capital of France?',
      'Paris.',
      'How many people live there?'
    ])
  })

  it('uses the generated prompt when personality settings are overridden', async () => {
    const overriddenConfiguration = parseConfiguration({
      ALFRED_EXTRA_INSTRUCTIONS: 'Use brief numbered steps when explaining a process.',
      ALFRED_RESPONSE_LENGTH: 'concise'
    })
    const provider = new FakeProvider(['Done.'])
    const engine = new ConversationEngine(provider, overriddenConfiguration, silentLogger)

    await collect(engine.sendMessage('Explain the process.'))

    expect(provider.requests[0]?.messages[0]?.content).toContain(
      'Use brief numbered steps when explaining a process.'
    )
    expect(provider.requests[0]?.messages[0]?.content).toContain('Keep responses focused and brief')
  })

  it('returns safe provider errors without exposing implementation details', async () => {
    const provider = new FakeProvider([], new LlmRequestError('unavailable', 'ECONNREFUSED secret'))
    const engine = new ConversationEngine(provider, configuration, silentLogger)

    await expect(collect(engine.sendMessage('Hello'))).resolves.toEqual([
      {
        type: 'error',
        error: {
          code: 'ollama_unavailable',
          message: 'ALFRED cannot reach the local Ollama service.'
        }
      }
    ])
  })

  it('reports an empty model response cleanly', async () => {
    const engine = new ConversationEngine(new FakeProvider(['']), configuration, silentLogger)

    await expect(collect(engine.sendMessage('Hello'))).resolves.toEqual([
      {
        type: 'error',
        error: { code: 'empty_response', message: 'The local model returned an empty response.' }
      }
    ])
  })

  it('reports cancellation and keeps the session usable', async () => {
    const controller = new AbortController()
    const provider = new FakeProvider(['unused'], undefined, controller)
    const engine = new ConversationEngine(provider, configuration, silentLogger)
    controller.abort()

    await expect(collect(engine.sendMessage('Stop', controller.signal))).resolves.toEqual([
      { type: 'error', error: { code: 'cancelled', message: 'Response generation was cancelled.' } }
    ])
    expect(engine.getMessages()).toHaveLength(1)
  })
})

class FakeProvider implements LlmProvider {
  readonly id = 'fake'
  readonly displayName = 'Fake provider'
  readonly requests: LlmChatRequest[] = []

  constructor(
    private readonly responses: string[],
    private readonly failure?: Error,
    private readonly controller?: AbortController
  ) {}

  async healthCheck(): Promise<LlmProviderHealth> {
    return { available: true, version: 'test' }
  }

  async discoverModels(): Promise<LlmModelDiscovery> {
    return {
      available: true,
      models: [],
      preferredModelAvailable: true,
      fallbackModelAvailable: false
    }
  }

  async *streamChat(request: LlmChatRequest, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk> {
    this.requests.push(request)
    if (this.controller?.signal.aborted === true || signal?.aborted === true) {
      throw new LlmRequestError('cancelled', 'cancelled')
    }
    if (this.failure !== undefined) throw this.failure

    const response = this.responses.shift() ?? ''
    for (const content of response.match(/.{1,5}/g) ?? []) yield { type: 'text-delta', content }
  }
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const event of events) collected.push(event)
  return collected
}
