/** A runtime-agnostic local model made available by an LLM provider. */
export interface LlmModel {
  readonly name: string
  readonly identifier?: string
  readonly modifiedAt?: string
  readonly sizeBytes?: number
  readonly digest?: string
  readonly family?: string
  readonly parameterSize?: string
  readonly quantizationLevel?: string
}

export type LlmProviderHealth =
  | {
      readonly available: true
      readonly version: string
    }
  | {
      readonly available: false
      readonly message: string
    }

export interface LlmModelDiscovery {
  readonly available: boolean
  readonly models: readonly LlmModel[]
  readonly preferredModelAvailable: boolean
  readonly fallbackModelAvailable: boolean
  readonly message?: string
}

/**
 * Local-model runtime boundary. Conversation orchestration depends on this interface,
 * never on a provider-specific HTTP API.
 */
export interface LlmProvider {
  readonly id: string
  readonly displayName: string

  healthCheck(): Promise<LlmProviderHealth>
  discoverModels(): Promise<LlmModelDiscovery>
  streamChat(request: LlmChatRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk>
}

export type LlmMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface LlmToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface LlmToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: unknown
  readonly index?: number
}

export type LlmChatMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | {
      readonly role: 'assistant'
      readonly content: string
      readonly toolCalls?: readonly LlmToolCall[]
      readonly thinking?: string
    }
  | {
      readonly role: 'tool'
      readonly content: string
      readonly toolCallId: string
      readonly name: string
    }

export interface LlmChatRequest {
  readonly model: string
  readonly messages: readonly LlmChatMessage[]
  readonly tools?: readonly LlmToolDefinition[]
}

export type LlmStreamChunk =
  | { readonly type: 'text-delta'; readonly content: string }
  | { readonly type: 'thinking-delta'; readonly content: string }
  | { readonly type: 'tool-call'; readonly call: LlmToolCall }

export type ToolExecutionOrigin = 'llm' | 'shortcut' | 'system'

export interface ToolExecutionRequest {
  readonly call: LlmToolCall
  readonly origin: ToolExecutionOrigin
  readonly requestId: string
  readonly signal?: AbortSignal
}

export type ToolExecutionResult =
  | {
      readonly ok: true
      readonly toolCallId: string
      readonly toolName: string
      readonly output: unknown
    }
  | {
      readonly ok: false
      readonly toolCallId: string
      readonly toolName: string
      readonly category:
        | 'unknown_tool'
        | 'disabled_tool'
        | 'invalid_arguments'
        | 'permission_denied'
        | 'confirmation_denied'
        | 'confirmation_unavailable'
        | 'confirmation_expired'
        | 'execution_error'
        | 'timeout'
        | 'cancelled'
      readonly message: string
    }

/** Runtime boundary implemented by the tools package; core never calls handlers directly. */
export interface ToolExecutor {
  getExecutableToolDescriptions(): readonly LlmToolDefinition[]
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>
}

export type LlmRequestErrorCode =
  | 'unavailable'
  | 'model_unavailable'
  | 'timeout'
  | 'stream_interrupted'
  | 'malformed_response'
  | 'empty_response'
  | 'cancelled'

export class LlmRequestError extends Error {
  constructor(
    readonly code: LlmRequestErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'LlmRequestError'
  }
}
