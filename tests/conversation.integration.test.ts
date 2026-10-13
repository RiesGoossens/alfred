import { describe, expect, it } from 'vitest'

import { ConversationEngine, parseConfiguration } from '@alfred/core'
import type { LlmToolCall, ToolExecutor } from '@alfred/core'
import { OllamaProvider } from '@alfred/providers'
import { createDemonstrationToolExecutor } from '@alfred/tools'

describe('local conversation integration', () => {
  it('streams two local turns through Ollama', async () => {
    const configuration = parseConfiguration({ ALFRED_OLLAMA_TIMEOUT_MS: '60000' })
    const engine = new ConversationEngine(new OllamaProvider(configuration.ollama), configuration)

    const firstResponse = await collect(
      engine.sendMessage(
        'In one short sentence, identify yourself as ALFRED and describe your current role.'
      )
    )
    const secondResponse = await collect(
      engine.sendMessage('Can you open an application on my computer right now? Answer briefly.')
    )

    expect(firstResponse).toMatch(/alfred/i)
    expect(secondResponse).toMatch(/cannot|can't|not able|no|niet mogelijk/i)
    expect(engine.getMessages().filter((message) => message.role === 'assistant')).toHaveLength(2)
  }, 120000)

  it('returns a verified calculate result through the local tool-call cycle', async () => {
    const configuration = parseConfiguration({ ALFRED_OLLAMA_TIMEOUT_MS: '60000' })
    const delegate = createDemonstrationToolExecutor()
    const observedCalls: LlmToolCall[] = []
    const executor: ToolExecutor = {
      getExecutableToolDescriptions: () => delegate.getExecutableToolDescriptions(),
      execute: async (request) => {
        observedCalls.push(request.call)
        return delegate.execute(request)
      }
    }
    const engine = new ConversationEngine(
      new OllamaProvider(configuration.ollama),
      configuration,
      undefined,
      executor
    )

    const response = await collect(
      engine.sendMessage(
        'Use the calculate tool to multiply 128 by 47. Do not calculate it yourself; report the tool result.'
      )
    )

    const toolMessages = engine.getMessages().filter((message) => message.role === 'tool')
    expect(observedCalls).toContainEqual(
      expect.objectContaining({
        name: 'calculate',
        arguments: { operation: 'multiply', operandA: 128, operandB: 47 }
      })
    )
    const toolMessage = toolMessages.find((message) =>
      message.content.includes('"status":"success"')
    )
    expect(toolMessage?.name).toBe('calculate')
    expect(toolMessage?.content).toContain('"status":"success"')
    expect(toolMessage?.content).toContain('6016')
    expect(response).toMatch(/6016|6,016/)
  }, 120000)
})

async function collect(events: AsyncIterable<{ type: string; content?: string }>): Promise<string> {
  let response = ''
  for await (const event of events) {
    if (event.type === 'assistant-delta') response += event.content ?? ''
    if (event.type === 'error') throw new Error('The local conversation request failed.')
  }
  return response
}
