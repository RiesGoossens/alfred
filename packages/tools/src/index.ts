import {
  getLogger,
  type LlmToolDefinition,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutor
} from '@alfred/core'
import type { Logger } from 'pino'
import { cpus, freemem, release, totalmem, type, uptime } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { z, type ZodTypeAny } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

export type ToolRisk = 'safe' | 'confirm' | 'restricted'

export interface ToolExecutionContext {
  readonly origin: 'llm' | 'shortcut' | 'system'
  readonly requestId: string
  readonly signal?: AbortSignal
}

export interface ConfirmationRequest {
  readonly id: string
  readonly toolId: string
  readonly toolName: string
  readonly action: string
  readonly target?: string
  readonly explanation: string
  readonly arguments: unknown
  readonly createdAt: number
}

export type ConfirmationDecision = 'approved' | 'denied' | 'expired' | 'cancelled'

/** A main-process owned boundary. Renderers never receive direct tool access. */
export interface ConfirmationProvider {
  isAvailable(): boolean
  request(request: ConfirmationRequest, signal?: AbortSignal): Promise<ConfirmationDecision>
}

export interface ToolDefinition {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly inputSchema: ZodTypeAny
  readonly risk: ToolRisk
  readonly enabled: boolean
  readonly confirmation?: (
    input: unknown
  ) => Omit<ConfirmationRequest, 'id' | 'toolId' | 'toolName' | 'arguments' | 'createdAt'>
  readonly execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.id)) throw new Error(`Tool "${tool.id}" is already registered.`)
    if (!/^[a-z][a-z0-9_]*$/.test(tool.id))
      throw new Error('Tool identifiers must be stable lowercase identifiers.')
    this.tools.set(tool.id, Object.freeze({ ...tool }))
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id)
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()]
  }

  listEnabled(): readonly ToolDefinition[] {
    return this.list().filter((tool) => tool.enabled)
  }

  describe(tools: readonly ToolDefinition[] = this.listEnabled()): readonly LlmToolDefinition[] {
    return tools.map((tool) => ({
      name: tool.id,
      description: tool.description,
      parameters: toModelJsonSchema(tool.inputSchema, tool.id)
    }))
  }
}

export class ExecutionPolicy {
  allows(
    tool: ToolDefinition,
    origin: ToolExecutionContext['origin'],
    confirmationAvailable = false
  ): boolean {
    void origin
    return (
      tool.enabled && (tool.risk === 'safe' || (tool.risk === 'confirm' && confirmationAvailable))
    )
  }
}

export class CentralToolExecutor implements ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly policy: ExecutionPolicy = new ExecutionPolicy(),
    private readonly logger: Logger = getLogger('tools'),
    private readonly timeoutMs = 5000,
    private readonly confirmationProvider?: ConfirmationProvider
  ) {}

  getExecutableToolDescriptions(): readonly LlmToolDefinition[] {
    return this.registry.describe(
      this.registry
        .listEnabled()
        .filter((tool) =>
          this.policy.allows(tool, 'llm', this.confirmationProvider?.isAvailable() === true)
        )
    )
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const startedAt = Date.now()
    const tool = this.registry.get(request.call.name)
    if (tool === undefined)
      return this.failure(request, 'unknown_tool', 'That tool is not registered.', startedAt)
    if (!tool.enabled)
      return this.failure(request, 'disabled_tool', 'That tool is not enabled.', startedAt)
    if (tool.risk === 'restricted')
      return this.failure(
        request,
        'permission_denied',
        'That tool is not permitted by the current policy.',
        startedAt
      )
    if (request.signal?.aborted === true)
      return this.failure(
        request,
        'cancelled',
        'Tool execution was cancelled before it started.',
        startedAt
      )

    const parsed = tool.inputSchema.safeParse(request.call.arguments)
    if (!parsed.success)
      return this.failure(
        request,
        'invalid_arguments',
        'The tool arguments were invalid.',
        startedAt
      )

    if (tool.risk === 'confirm') {
      if (this.confirmationProvider?.isAvailable() !== true)
        return this.failure(
          request,
          'confirmation_unavailable',
          'Confirmation is unavailable, so this action was not performed.',
          startedAt
        )
      const confirmation = tool.confirmation?.(parsed.data) ?? {
        action: tool.displayName,
        explanation: tool.description
      }
      const confirmationRequest: ConfirmationRequest = {
        id: crypto.randomUUID(),
        toolId: tool.id,
        toolName: tool.displayName,
        arguments: parsed.data,
        createdAt: Date.now(),
        ...confirmation
      }
      this.logger.info(
        { requestId: confirmationRequest.id, toolId: tool.id },
        'Confirmation requested'
      )
      const decision = await this.confirmationProvider.request(confirmationRequest, request.signal)
      this.logger.info(
        {
          requestId: confirmationRequest.id,
          toolId: tool.id,
          decision,
          durationMs: Date.now() - startedAt
        },
        'Confirmation resolved'
      )
      if (decision !== 'approved')
        return this.failure(
          request,
          decision === 'expired'
            ? 'confirmation_expired'
            : decision === 'cancelled'
              ? 'cancelled'
              : 'confirmation_denied',
          decision === 'expired'
            ? 'The approval request expired, so this action was not performed.'
            : decision === 'cancelled'
              ? 'The approval request was cancelled, so this action was not performed.'
              : 'The user declined this action, so it was not performed.',
          startedAt
        )
      if (isSignalAborted(request.signal) || !this.policy.allows(tool, request.origin, true))
        return this.failure(
          request,
          'cancelled',
          'Tool execution was cancelled before approval completed.',
          startedAt
        )
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    this.logger.info({ toolId: tool.id, origin: request.origin }, 'Tool execution started')
    try {
      const output = await tool.execute(parsed.data, {
        origin: request.origin,
        requestId: request.requestId,
        signal: controller.signal
      })
      if (controller.signal.aborted) {
        return this.failure(
          request,
          request.signal?.aborted ? 'cancelled' : 'timeout',
          request.signal?.aborted ? 'Tool execution was cancelled.' : 'Tool execution timed out.',
          startedAt
        )
      }
      this.logger.info(
        { toolId: tool.id, origin: request.origin, durationMs: Date.now() - startedAt },
        'Tool execution completed'
      )
      return { ok: true, toolCallId: request.call.id, toolName: tool.id, output }
    } catch {
      const category = controller.signal.aborted
        ? request.signal?.aborted
          ? 'cancelled'
          : 'timeout'
        : 'execution_error'
      return this.failure(
        request,
        category,
        category === 'timeout'
          ? 'Tool execution timed out.'
          : category === 'cancelled'
            ? 'Tool execution was cancelled.'
            : 'The tool could not complete.',
        startedAt
      )
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

  private failure(
    request: ToolExecutionRequest,
    category: Extract<ToolExecutionResult, { ok: false }>['category'],
    message: string,
    startedAt: number
  ): Extract<ToolExecutionResult, { ok: false }> {
    this.logger.warn(
      {
        toolId: request.call.name,
        origin: request.origin,
        category,
        durationMs: Date.now() - startedAt
      },
      'Tool execution failed'
    )
    return {
      ok: false,
      toolCallId: request.call.id,
      toolName: request.call.name,
      category,
      message
    }
  }
}

export const getCurrentTimeTool: ToolDefinition = {
  id: 'get_current_time',
  displayName: 'Get current time',
  description: 'Returns the current local date and time.',
  inputSchema: z.object({}).strict(),
  risk: 'safe',
  enabled: true,
  async execute(_input, context) {
    if (context.signal?.aborted) throw new Error('cancelled')
    return { localDateTime: new Date().toLocaleString() }
  }
}

const calculateInputSchema = z
  .object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    operandA: z.number().finite(),
    operandB: z.number().finite()
  })
  .strict()

export const calculateTool: ToolDefinition = {
  id: 'calculate',
  displayName: 'Calculate',
  description:
    'Performs basic arithmetic. Supply exactly {"operation":"add"|"subtract"|"multiply"|"divide","operandA":number,"operandB":number}. Do not use a, b, num1, num2, or expression fields.',
  inputSchema: calculateInputSchema,
  risk: 'safe',
  enabled: true,
  async execute(input, context) {
    if (context.signal?.aborted) throw new Error('cancelled')
    const values = calculateInputSchema.parse(input)
    const result =
      values.operation === 'add'
        ? values.operandA + values.operandB
        : values.operation === 'subtract'
          ? values.operandA - values.operandB
          : values.operation === 'multiply'
            ? values.operandA * values.operandB
            : values.operandB === 0
              ? Number.NaN
              : values.operandA / values.operandB
    if (!Number.isFinite(result)) throw new Error('invalid arithmetic result')
    return { result }
  }
}

type SupportedApplication = {
  readonly id: 'notepad' | 'calculator' | 'file_explorer'
  readonly name: string
  readonly command: string
}
const supportedApplications: readonly SupportedApplication[] = [
  { id: 'notepad', name: 'Notepad', command: 'notepad.exe' },
  { id: 'calculator', name: 'Calculator', command: 'calc.exe' },
  { id: 'file_explorer', name: 'File Explorer', command: 'explorer.exe' }
]

function availableApplications(): readonly SupportedApplication[] {
  if (process.platform !== 'win32') return []
  const windowsDirectory = process.env.WINDIR ?? 'C:\\Windows'
  return supportedApplications.filter((application) =>
    existsSync(
      join(
        windowsDirectory,
        application.id === 'file_explorer' ? application.command : 'System32',
        application.command
      )
    )
  )
}

export const getSystemInfoTool: ToolDefinition = {
  id: 'get_system_info',
  displayName: 'Get system information',
  description: 'Returns basic non-personal system information.',
  inputSchema: z.object({}).strict(),
  risk: 'safe',
  enabled: true,
  async execute(_input, context) {
    if (context.signal?.aborted) throw new Error('cancelled')
    const cpu = cpus()[0]
    const rawVersion = release()
    return {
      operatingSystem: identifyOperatingSystem(type(), rawVersion),
      operatingSystemVersion: rawVersion,
      architecture: process.arch,
      cpuModel: cpu?.model ?? 'Unavailable',
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      availableMemoryBytes: freemem(),
      uptimeSeconds: uptime()
    }
  }
}

export const getSystemUsageTool: ToolDefinition = {
  id: 'get_system_usage',
  displayName: 'Get system usage',
  description: 'Returns a current memory and ALFRED-process memory snapshot.',
  inputSchema: z.object({}).strict(),
  risk: 'safe',
  enabled: true,
  async execute(_input, context) {
    if (context.signal?.aborted) throw new Error('cancelled')
    const total = totalmem()
    const available = freemem()
    const processMemory = process.memoryUsage()
    return {
      totalMemoryBytes: total,
      availableMemoryBytes: available,
      usedMemoryBytes: total - available,
      memoryUsagePercent: Number((((total - available) / total) * 100).toFixed(2)),
      alfredProcessRssBytes: processMemory.rss
    }
  }
}

export const listSupportedApplicationsTool: ToolDefinition = {
  id: 'list_supported_applications',
  displayName: 'List supported applications',
  description: 'Lists allowlisted Windows applications currently available to ALFRED.',
  inputSchema: z.object({}).strict(),
  risk: 'safe',
  enabled: true,
  async execute(_input, context) {
    if (context.signal?.aborted) throw new Error('cancelled')
    return { applications: availableApplications().map(({ id, name }) => ({ id, name })) }
  }
}

export const openApplicationTool: ToolDefinition = {
  id: 'open_application',
  displayName: 'Open application',
  description: 'Launches a supported allowlisted Windows application after confirmation.',
  inputSchema: z
    .object({ applicationId: z.enum(['notepad', 'calculator', 'file_explorer']) })
    .strict(),
  risk: 'confirm',
  enabled: true,
  confirmation(input) {
    const { applicationId } = z
      .object({ applicationId: z.enum(['notepad', 'calculator', 'file_explorer']) })
      .parse(input)
    const application = supportedApplications.find((candidate) => candidate.id === applicationId)
    return {
      action: `Open ${application?.name ?? 'application'}`,
      explanation: 'ALFRED will ask Windows to launch this supported application.',
      ...(application === undefined ? {} : { target: application.name })
    }
  },
  async execute(input, context) {
    if (context.signal?.aborted) throw new Error('cancelled')
    const { applicationId } = z
      .object({ applicationId: z.enum(['notepad', 'calculator', 'file_explorer']) })
      .strict()
      .parse(input)
    const application = availableApplications().find((candidate) => candidate.id === applicationId)
    if (application === undefined) throw new Error('application unavailable')
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      const child = spawn(application.command, [], {
        shell: false,
        detached: true,
        stdio: 'ignore'
      })
      child.once('error', rejectLaunch)
      child.once('spawn', () => {
        child.unref()
        resolveLaunch()
      })
    })
    return { applicationId: application.id, launchInitiated: true }
  }
}

export function createDemonstrationToolExecutor(
  logger?: Logger,
  confirmationProvider?: ConfirmationProvider
): CentralToolExecutor {
  const registry = new ToolRegistry()
  registry.register(getCurrentTimeTool)
  registry.register(calculateTool)
  registry.register(getSystemInfoTool)
  registry.register(getSystemUsageTool)
  registry.register(listSupportedApplicationsTool)
  registry.register(openApplicationTool)
  return new CentralToolExecutor(
    registry,
    new ExecutionPolicy(),
    logger,
    5000,
    confirmationProvider
  )
}

/** Windows NT reports 10.0 for both Windows 10 and 11; product build separates them. */
export function identifyOperatingSystem(platform: string, rawVersion: string): string {
  if (platform !== 'Windows_NT') return platform
  const build = /\d+\.\d+\.(\d+)/.exec(rawVersion)?.[1]
  if (build === undefined) return 'Windows'
  return Number(build) >= 22000 ? 'Windows 11' : 'Windows 10'
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}

function toModelJsonSchema(schema: ZodTypeAny, name: string): Record<string, unknown> {
  const converted = zodToJsonSchema(schema, { name, $refStrategy: 'none' })
  if (converted === null || typeof converted !== 'object' || Array.isArray(converted))
    throw new Error(`Tool "${name}" has an unsupported input schema.`)
  return converted as Record<string, unknown>
}
