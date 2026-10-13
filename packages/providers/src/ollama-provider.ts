import {
  getLogger,
  LlmRequestError,
  type LlmChatRequest,
  type LlmToolCall,
  LlmModel,
  LlmModelDiscovery,
  LlmProvider,
  LlmProviderHealth,
  LlmStreamChunk,
  Logger,
  OllamaConfiguration
} from '@alfred/core'

type FetchImplementation = typeof fetch

interface OllamaVersionResponse {
  version?: unknown
}

interface OllamaTagsResponse {
  models?: unknown
}

interface OllamaModelResponse {
  name?: unknown
  model?: unknown
  modified_at?: unknown
  size?: unknown
  digest?: unknown
  details?: {
    family?: unknown
    parameter_size?: unknown
    quantization_level?: unknown
  }
}

interface OllamaChatChunk {
  message?: { content?: unknown; thinking?: unknown; tool_calls?: unknown }
  done?: unknown
  error?: unknown
}

/** Local Ollama HTTP adapter. It never downloads, selects, or runs a model. */
export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama'
  readonly displayName = 'Ollama'

  private readonly baseUrl: string

  constructor(
    private readonly configuration: OllamaConfiguration,
    private readonly logger: Logger = getLogger('ollama'),
    private readonly fetchImplementation: FetchImplementation = globalThis.fetch
  ) {
    this.baseUrl = configuration.baseUrl.replace(/\/$/, '')
  }

  async healthCheck(): Promise<LlmProviderHealth> {
    this.logger.debug({ baseUrl: this.baseUrl }, 'Checking Ollama connection')

    try {
      const response = await this.getJson<OllamaVersionResponse>('/api/version')

      if (typeof response.version !== 'string' || response.version.length === 0) {
        throw new Error('Ollama returned an invalid version response.')
      }

      this.logger.info({ version: response.version }, 'Ollama health check succeeded')
      return { available: true, version: response.version }
    } catch (error) {
      const message = describeError(error)
      this.logger.warn({ err: error, baseUrl: this.baseUrl }, 'Ollama is unavailable')
      return { available: false, message }
    }
  }

  async discoverModels(): Promise<LlmModelDiscovery> {
    this.logger.debug({ baseUrl: this.baseUrl }, 'Discovering local Ollama models')

    try {
      const response = await this.getJson<OllamaTagsResponse>('/api/tags')
      const models = parseModels(response.models)
      const installedNames = new Set(models.map((model) => model.name))
      const preferredModelAvailable = installedNames.has(this.configuration.model)
      const fallbackModelAvailable = installedNames.has(this.configuration.fallbackModel)

      this.logger.info(
        {
          modelCount: models.length,
          preferredModel: this.configuration.model,
          preferredModelAvailable,
          fallbackModel: this.configuration.fallbackModel,
          fallbackModelAvailable
        },
        'Ollama model discovery completed'
      )

      return {
        available: true,
        models,
        preferredModelAvailable,
        fallbackModelAvailable
      }
    } catch (error) {
      const message = describeError(error)
      this.logger.warn({ err: error, baseUrl: this.baseUrl }, 'Ollama model discovery failed')
      return {
        available: false,
        models: [],
        preferredModelAvailable: false,
        fallbackModelAvailable: false,
        message
      }
    }
  }

  async *streamChat(request: LlmChatRequest, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk> {
    this.logger.info({ model: request.model }, 'Ollama model request started')
    const abortController = new AbortController()
    const onAbort = () => abortController.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => abortController.abort(), this.configuration.responseTimeoutMs)

    try {
      const response = await this.fetchImplementation(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { accept: 'application/x-ndjson', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toOllamaMessage),
          ...(request.tools === undefined || request.tools.length === 0
            ? {}
            : { tools: request.tools.map(toOllamaTool) }),
          stream: true
        }),
        signal: abortController.signal
      })

      if (!response.ok) {
        const responseText = await response.text()
        const code =
          response.status === 404 || /model.*not found/i.test(responseText)
            ? 'model_unavailable'
            : 'unavailable'
        throw new LlmRequestError(code, `Ollama API responded with HTTP ${response.status}.`)
      }

      if (response.body === null) {
        throw new LlmRequestError('malformed_response', 'Ollama returned no response body.')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let completed = false

      while (!completed) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const chunk = parseChatChunk(line)
          if (typeof chunk.message?.content === 'string' && chunk.message.content.length > 0) {
            yield { type: 'text-delta', content: chunk.message.content }
          }
          if (typeof chunk.message?.thinking === 'string' && chunk.message.thinking.length > 0) {
            yield { type: 'thinking-delta', content: chunk.message.thinking }
          }
          for (const call of parseToolCalls(chunk.message?.tool_calls))
            yield { type: 'tool-call', call }
          if (chunk.done === true) completed = true
        }

        if (done && !completed) {
          if (buffer.trim().length > 0) {
            const chunk = parseChatChunk(buffer)
            if (typeof chunk.message?.content === 'string' && chunk.message.content.length > 0) {
              yield { type: 'text-delta', content: chunk.message.content }
            }
            if (typeof chunk.message?.thinking === 'string' && chunk.message.thinking.length > 0) {
              yield { type: 'thinking-delta', content: chunk.message.thinking }
            }
            for (const call of parseToolCalls(chunk.message?.tool_calls))
              yield { type: 'tool-call', call }
            completed = chunk.done === true
          }
          if (!completed)
            throw new LlmRequestError('stream_interrupted', 'Ollama ended the stream early.')
        }
      }
    } catch (error) {
      if (error instanceof LlmRequestError) throw error
      if (signal?.aborted === true) throw new LlmRequestError('cancelled', 'Request cancelled.')
      if (abortController.signal.aborted)
        throw new LlmRequestError('timeout', 'Ollama request timed out.')
      throw new LlmRequestError('unavailable', 'Unable to reach the local Ollama service.')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), this.configuration.timeoutMs)

    try {
      const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: abortController.signal
      })

      if (!response.ok) {
        throw new Error(`Ollama API responded with HTTP ${response.status}.`)
      }

      return (await response.json()) as T
    } finally {
      clearTimeout(timeout)
    }
  }
}

function toOllamaTool(tool: {
  name: string
  description: string
  parameters: Record<string, unknown>
}) {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }
}

function toOllamaMessage(message: LlmChatRequest['messages'][number]): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_name: message.name
    }
  }
  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
      tool_calls: message.toolCalls.map((call, index) => ({
        type: 'function',
        function: { index, name: call.name, arguments: call.arguments }
      }))
    }
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.role === 'assistant' && message.thinking === undefined
      ? {}
      : message.role === 'assistant'
        ? { thinking: message.thinking }
        : {})
  }
}

function parseToolCalls(value: unknown): LlmToolCall[] {
  if (value === undefined) return []
  if (!Array.isArray(value))
    throw new LlmRequestError('malformed_response', 'Ollama returned invalid tool calls.')

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null)
      throw new LlmRequestError('malformed_response', 'Ollama returned invalid tool calls.')
    const call = entry as {
      id?: unknown
      function?: { index?: unknown; name?: unknown; arguments?: unknown }
    }
    if (typeof call.function?.name !== 'string' || call.function.name.length === 0)
      throw new LlmRequestError('malformed_response', 'Ollama returned a tool call without a name.')
    return {
      id: typeof call.id === 'string' ? call.id : `ollama-call-${index}`,
      name: call.function.name,
      arguments: call.function.arguments ?? {},
      ...(typeof call.function.index === 'number' ? { index: call.function.index } : {})
    }
  })
}

function parseChatChunk(line: string): OllamaChatChunk {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) {
      throw new Error('Response was not an object.')
    }
    const chunk = value as OllamaChatChunk
    if (typeof chunk.error === 'string') {
      throw new LlmRequestError('stream_interrupted', 'Ollama returned a streaming error.')
    }
    return chunk
  } catch (error) {
    if (error instanceof LlmRequestError) throw error
    throw new LlmRequestError('malformed_response', 'Ollama returned malformed streaming data.')
  }
}

function parseModels(value: unknown): LlmModel[] {
  if (!Array.isArray(value)) {
    throw new Error('Ollama returned an invalid model list.')
  }

  return value.map((entry) => parseModel(entry))
}

function parseModel(value: unknown): LlmModel {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Ollama returned an invalid model entry.')
  }

  const model = value as OllamaModelResponse

  if (typeof model.name !== 'string' || model.name.length === 0) {
    throw new Error('Ollama returned a model without a name.')
  }

  return {
    name: model.name,
    ...(typeof model.model === 'string' ? { identifier: model.model } : {}),
    ...(typeof model.modified_at === 'string' ? { modifiedAt: model.modified_at } : {}),
    ...(typeof model.size === 'number' ? { sizeBytes: model.size } : {}),
    ...(typeof model.digest === 'string' ? { digest: model.digest } : {}),
    ...(typeof model.details?.family === 'string' ? { family: model.details.family } : {}),
    ...(typeof model.details?.parameter_size === 'string'
      ? { parameterSize: model.details.parameter_size }
      : {}),
    ...(typeof model.details?.quantization_level === 'string'
      ? { quantizationLevel: model.details.quantization_level }
      : {})
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown Ollama connection failure.'
}
