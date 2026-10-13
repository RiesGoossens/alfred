import type { Logger } from 'pino'

import type { AlfredConfiguration } from './configuration.js'
import { getLogger } from './logger.js'
import {
  LlmRequestError,
  type LlmChatMessage,
  type LlmProvider,
  type LlmToolCall,
  type ToolExecutor
} from './llm-provider.js'
import { buildSystemPrompt, createPersonality } from './personality.js'

export type ConversationMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ConversationMessage {
  readonly id: string
  readonly role: ConversationMessageRole
  readonly content: string
  readonly createdAt: string
  readonly toolCalls?: readonly LlmToolCall[]
  readonly thinking?: string
  readonly toolCallId?: string
  readonly name?: string
}

export type ConversationErrorCode =
  | 'invalid_message'
  | 'ollama_unavailable'
  | 'model_unavailable'
  | 'request_timeout'
  | 'stream_interrupted'
  | 'malformed_response'
  | 'empty_response'
  | 'cancelled'

export interface ConversationError {
  readonly code: ConversationErrorCode
  readonly message: string
}

export type ConversationEvent =
  | { readonly type: 'assistant-delta'; readonly content: string }
  | { readonly type: 'assistant-complete'; readonly message: ConversationMessage }
  | { readonly type: 'error'; readonly error: ConversationError }

/** Session-only text conversation coordinator. It has no tools or persistent memory. */
export class ConversationEngine {
  private messages: ConversationMessage[]

  constructor(
    private readonly provider: LlmProvider,
    private readonly configuration: Pick<AlfredConfiguration, 'ollama' | 'personality'>,
    private readonly logger: Logger = getLogger('conversation'),
    private readonly toolExecutor?: ToolExecutor
  ) {
    this.messages = [createMessage('system', this.systemPrompt())]
  }

  getMessages(): readonly ConversationMessage[] {
    return [...this.messages]
  }

  clear(): void {
    this.messages = [createMessage('system', this.systemPrompt())]
    this.logger.info('Conversation session cleared')
  }

  private systemPrompt(): string {
    return buildSystemPrompt(
      createPersonality(this.configuration.personality),
      this.toolExecutor?.getExecutableToolDescriptions() ?? []
    )
  }

  async *sendMessage(content: string, signal?: AbortSignal): AsyncGenerator<ConversationEvent> {
    const trimmedContent = content.trim()

    if (trimmedContent.length === 0) {
      yield { type: 'error', error: { code: 'invalid_message', message: 'Enter a message first.' } }
      return
    }

    if (signal?.aborted === true) {
      yield { type: 'error', error: cancelledError }
      return
    }

    this.messages.push(createMessage('user', trimmedContent))
    this.logger.info({ messageCount: this.messages.length }, 'Conversation message submitted')

    let responseContent = ''
    let thinkingContent = ''
    let receivedFirstChunk = false

    try {
      for (let round = 0; round <= 3; round += 1) {
        const toolCalls = new Map<string, LlmToolCall>()
        this.logger.info(
          { model: this.configuration.ollama.model, round },
          'Model response started'
        )
        for await (const chunk of this.provider.streamChat(
          {
            model: this.configuration.ollama.model,
            messages: toLlmMessages(this.messages),
            ...(this.toolExecutor === undefined
              ? {}
              : { tools: this.toolExecutor.getExecutableToolDescriptions() })
          },
          signal
        )) {
          if (chunk.type === 'tool-call') {
            toolCalls.set(chunk.call.id, chunk.call)
            continue
          }
          if (chunk.type === 'thinking-delta') {
            thinkingContent += chunk.content
            continue
          }
          if (chunk.content.length === 0) continue
          if (!receivedFirstChunk) {
            receivedFirstChunk = true
            this.logger.info('First model response chunk received')
          }
          responseContent += chunk.content
          yield { type: 'assistant-delta', content: chunk.content }
        }

        if (toolCalls.size === 0) {
          if (responseContent.trim().length === 0)
            throw new LlmRequestError('empty_response', 'The model returned an empty response.')
          const assistantMessage = createMessage(
            'assistant',
            responseContent,
            undefined,
            thinkingContent
          )
          this.messages.push(assistantMessage)
          this.logger.info({ messageCount: this.messages.length }, 'Model response completed')
          yield { type: 'assistant-complete', message: assistantMessage }
          return
        }
        if (this.toolExecutor === undefined)
          throw new LlmRequestError('malformed_response', 'Tool calls are unavailable.')
        if (round === 3)
          throw new LlmRequestError('stream_interrupted', 'Tool-call round limit reached.')

        this.messages.push(
          createMessage('assistant', responseContent, [...toolCalls.values()], thinkingContent)
        )
        responseContent = ''
        thinkingContent = ''
        for (const call of toolCalls.values()) {
          const result = await this.toolExecutor.execute({
            call,
            origin: 'llm',
            requestId: crypto.randomUUID(),
            ...(signal === undefined ? {} : { signal })
          })
          this.messages.push(createToolMessage(call.id, call.name, toModelToolResult(result)))
        }
      }
    } catch (error) {
      if (responseContent.length > 0)
        this.messages.push(createMessage('assistant', responseContent))

      const conversationError = toConversationError(error, signal)
      this.logger.warn({ code: conversationError.code }, 'Conversation request failed')
      yield { type: 'error', error: conversationError }
    }
  }
}

const cancelledError: ConversationError = {
  code: 'cancelled',
  message: 'Response generation was cancelled.'
}

function createMessage(
  role: ConversationMessageRole,
  content: string,
  toolCalls?: LlmToolCall[],
  thinking?: string
): ConversationMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(thinking === undefined || thinking.length === 0 ? {} : { thinking })
  }
}

function createToolMessage(toolCallId: string, name: string, content: string): ConversationMessage {
  return {
    id: crypto.randomUUID(),
    role: 'tool',
    content,
    createdAt: new Date().toISOString(),
    toolCallId,
    name
  }
}

function toLlmMessages(messages: readonly ConversationMessage[]): LlmChatMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || message.name === undefined)
        throw new Error('Tool message is missing call metadata.')
      return {
        role: 'tool',
        content: message.content,
        toolCallId: message.toolCallId,
        name: message.name
      }
    }
    return message.role === 'assistant' && message.toolCalls !== undefined
      ? {
          role: 'assistant',
          content: message.content,
          toolCalls: message.toolCalls,
          ...(message.thinking === undefined ? {} : { thinking: message.thinking })
        }
      : { role: message.role as 'system' | 'user' | 'assistant', content: message.content }
  })
}

function toModelToolResult(result: import('./llm-provider.js').ToolExecutionResult): string {
  return result.ok
    ? JSON.stringify({ status: 'success', tool_name: result.toolName, result: result.output })
    : JSON.stringify({
        status: 'failure',
        tool_name: result.toolName,
        category: result.category,
        message: result.message
      })
}

function toConversationError(error: unknown, signal?: AbortSignal): ConversationError {
  if (
    signal?.aborted === true ||
    (error instanceof LlmRequestError && error.code === 'cancelled')
  ) {
    return cancelledError
  }

  if (error instanceof LlmRequestError) {
    const mappedCodes: Record<LlmRequestError['code'], ConversationErrorCode> = {
      unavailable: 'ollama_unavailable',
      model_unavailable: 'model_unavailable',
      timeout: 'request_timeout',
      stream_interrupted: 'stream_interrupted',
      malformed_response: 'malformed_response',
      empty_response: 'empty_response',
      cancelled: 'cancelled'
    }
    return { code: mappedCodes[error.code], message: safeMessage(error.code) }
  }

  return { code: 'stream_interrupted', message: 'The response stream was interrupted.' }
}

function safeMessage(code: LlmRequestError['code']): string {
  const messages: Record<LlmRequestError['code'], string> = {
    unavailable: 'ALFRED cannot reach the local Ollama service.',
    model_unavailable: 'The configured Ollama model is not installed.',
    timeout: 'The local model took too long to respond.',
    stream_interrupted: 'The response stream was interrupted.',
    malformed_response: 'The local model returned an invalid response.',
    empty_response: 'The local model returned an empty response.',
    cancelled: cancelledError.message
  }
  return messages[code]
}
