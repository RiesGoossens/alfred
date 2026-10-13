import { describe, expect, it, vi } from 'vitest'
import pino from 'pino'

import { parseConfiguration } from '@alfred/core'
import { OllamaProvider } from '@alfred/providers'

const configuration = parseConfiguration({})
const silentLogger = pino({ enabled: false })

describe('OllamaProvider', () => {
  it('constructs as the local Ollama LLM provider', () => {
    const provider = new OllamaProvider(configuration.ollama, silentLogger)

    expect(provider.id).toBe('ollama')
    expect(provider.displayName).toBe('Ollama')
  })

  it('reports a successful health check from the Ollama version endpoint', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse({ version: '0.32.13' }))
    const provider = new OllamaProvider(configuration.ollama, silentLogger, fetchImplementation)

    await expect(provider.healthCheck()).resolves.toEqual({ available: true, version: '0.32.13' })
    expect(fetchImplementation).toHaveBeenCalledWith(
      'http://localhost:11434/api/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('reports an unavailable runtime without throwing when the request fails', async () => {
    const provider = new OllamaProvider(
      configuration.ollama,
      silentLogger,
      vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
    )

    await expect(provider.healthCheck()).resolves.toEqual({
      available: false,
      message: 'connect ECONNREFUSED'
    })
  })

  it('parses discovered model metadata and preferred-model availability', async () => {
    const provider = new OllamaProvider(
      configuration.ollama,
      silentLogger,
      vi.fn().mockResolvedValue(
        jsonResponse({
          models: [
            {
              name: 'qwen3:8b',
              model: 'qwen3:8b',
              modified_at: '2026-08-15T00:00:00Z',
              size: 5200000000,
              digest: 'abc123',
              details: {
                family: 'qwen3',
                parameter_size: '8B',
                quantization_level: 'Q4_K_M'
              }
            }
          ]
        })
      )
    )

    await expect(provider.discoverModels()).resolves.toEqual({
      available: true,
      models: [
        {
          name: 'qwen3:8b',
          identifier: 'qwen3:8b',
          modifiedAt: '2026-08-15T00:00:00Z',
          sizeBytes: 5200000000,
          digest: 'abc123',
          family: 'qwen3',
          parameterSize: '8B',
          quantizationLevel: 'Q4_K_M'
        }
      ],
      preferredModelAvailable: true,
      fallbackModelAvailable: false
    })
  })

  it('reports a missing preferred model without selecting a replacement', async () => {
    const provider = new OllamaProvider(
      configuration.ollama,
      silentLogger,
      vi.fn().mockResolvedValue(jsonResponse({ models: [{ name: 'llama3.2:3b' }] }))
    )

    await expect(provider.discoverModels()).resolves.toMatchObject({
      available: true,
      preferredModelAvailable: false,
      fallbackModelAvailable: false,
      models: [{ name: 'llama3.2:3b' }]
    })
  })

  it('parses streamed Ollama chat chunks as they arrive', async () => {
    const provider = new OllamaProvider(
      configuration.ollama,
      silentLogger,
      vi
        .fn()
        .mockResolvedValue(
          streamingResponse([
            '{"message":{"content":"Hello"},"done":false}\n',
            '{"message":{"content":" there"},"done":false}\n',
            '{"done":true}\n'
          ])
        )
    )
    const chunks: string[] = []

    for await (const chunk of provider.streamChat({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'Hi' }]
    })) {
      chunks.push(chunk.content)
    }

    expect(chunks).toEqual(['Hello', ' there'])
  })

  it('serializes tool-result messages with Ollama tool_name and preserves assistant tool context', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(streamingResponse(['{"message":{"content":"Done."},"done":true}\n']))
    const provider = new OllamaProvider(configuration.ollama, silentLogger, fetchImplementation)

    for await (const chunk of provider.streamChat({
      model: 'qwen3:8b',
      messages: [
        { role: 'user', content: 'Calculate 128 multiplied by 47.' },
        {
          role: 'assistant',
          content: '',
          thinking: 'I should use the calculator.',
          toolCalls: [
            {
              id: 'internal-call-id',
              index: 0,
              name: 'calculate',
              arguments: { operation: 'multiply', operandA: 128, operandB: 47 }
            }
          ]
        },
        {
          role: 'tool',
          toolCallId: 'internal-call-id',
          name: 'calculate',
          content: '{"status":"success","tool_name":"calculate","result":{"result":6016}}'
        }
      ]
    })) {
      // Exhaust the deterministic response stream.
      void chunk
    }

    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[1]).toMatchObject({
      role: 'assistant',
      thinking: 'I should use the calculator.',
      tool_calls: [{ function: { index: 0, name: 'calculate' } }]
    })
    expect(body.messages[2]).toEqual({
      role: 'tool',
      tool_name: 'calculate',
      content: '{"status":"success","tool_name":"calculate","result":{"result":6016}}'
    })
    expect(body.messages[2]).not.toHaveProperty('tool_call_id')
    expect(body.messages[2]).not.toHaveProperty('name')
  })

  it('emits thinking and multiple structured tool calls without turning them into text', async () => {
    const provider = new OllamaProvider(
      configuration.ollama,
      silentLogger,
      vi
        .fn()
        .mockResolvedValue(
          streamingResponse([
            '{"message":{"thinking":"Use tools.","tool_calls":[{"function":{"index":0,"name":"calculate","arguments":{"operation":"add","operandA":1,"operandB":2}}},{"function":{"index":1,"name":"calculate","arguments":{"operation":"multiply","operandA":3,"operandB":4}}}]},"done":true}\n'
          ])
        )
    )
    const chunks = [] as Array<{
      type: string
      content?: string
      call?: { name: string; index?: number }
    }>
    for await (const chunk of provider.streamChat({ model: 'qwen3:8b', messages: [] }))
      chunks.push(chunk)

    expect(chunks).toEqual([
      { type: 'thinking-delta', content: 'Use tools.' },
      expect.objectContaining({
        type: 'tool-call',
        call: expect.objectContaining({ name: 'calculate', index: 0 })
      }),
      expect.objectContaining({
        type: 'tool-call',
        call: expect.objectContaining({ name: 'calculate', index: 1 })
      })
    ])
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function streamingResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}
