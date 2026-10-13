import { describe, expect, it } from 'vitest'

import type { ToolDefinition } from '@alfred/tools'
import {
  calculateTool,
  CentralToolExecutor,
  ExecutionPolicy,
  getSystemInfoTool,
  getSystemUsageTool,
  getCurrentTimeTool,
  identifyOperatingSystem,
  listSupportedApplicationsTool,
  openApplicationTool,
  ToolRegistry
} from '@alfred/tools'
import type { ConfirmationDecision, ConfirmationProvider, ConfirmationRequest } from '@alfred/tools'
import { z } from 'zod'

function request(name: string, argumentsValue: unknown) {
  return {
    call: { id: 'call-1', name, arguments: argumentsValue },
    origin: 'llm' as const,
    requestId: 'test'
  }
}

describe('tool registry and executor', () => {
  it('registers stable provider-independent descriptions and rejects duplicates', () => {
    const registry = new ToolRegistry()
    registry.register(calculateTool)
    expect(registry.describe()).toMatchObject([
      { name: 'calculate', description: calculateTool.description }
    ])
    expect(() => registry.register(calculateTool)).toThrow('already registered')
    expect(registry.get('missing')).toBeUndefined()
  })

  it('executes safe enabled tools with validated inputs', async () => {
    const registry = new ToolRegistry()
    registry.register(calculateTool)
    const executor = new CentralToolExecutor(registry)
    await expect(
      executor.execute(request('calculate', { operation: 'multiply', operandA: 6, operandB: 7 }))
    ).resolves.toMatchObject({ ok: true, output: { result: 42 } })
    await expect(
      executor.execute(request('calculate', { operation: 'divide', operandA: 1, operandB: 0 }))
    ).resolves.toMatchObject({ ok: false, category: 'execution_error' })
    await expect(
      executor.execute(
        request('calculate', { operation: 'add', operandA: 1, operandB: 2, extra: true })
      )
    ).resolves.toMatchObject({ ok: false, category: 'invalid_arguments' })
  })

  it('denies unknown, disabled, confirm, and restricted requests without executing handlers', async () => {
    const registry = new ToolRegistry()
    let called = false
    const denied = (id: string, risk: ToolDefinition['risk'], enabled = true): ToolDefinition => ({
      id,
      displayName: id,
      description: id,
      inputSchema: z.object({}).strict(),
      risk,
      enabled,
      async execute() {
        called = true
        return {}
      }
    })
    registry.register(denied('disabled_tool', 'safe', false))
    registry.register(denied('confirm_tool', 'confirm'))
    registry.register(denied('restricted_tool', 'restricted'))
    const executor = new CentralToolExecutor(registry, new ExecutionPolicy())
    await expect(executor.execute(request('missing', {}))).resolves.toMatchObject({
      category: 'unknown_tool'
    })
    await expect(executor.execute(request('disabled_tool', {}))).resolves.toMatchObject({
      category: 'disabled_tool'
    })
    await expect(executor.execute(request('confirm_tool', {}))).resolves.toMatchObject({
      category: 'confirmation_unavailable'
    })
    await expect(executor.execute(request('restricted_tool', {}))).resolves.toMatchObject({
      category: 'permission_denied'
    })
    expect(called).toBe(false)
  })

  it('exposes only executable safe tools', () => {
    const registry = new ToolRegistry()
    registry.register(getCurrentTimeTool)
    registry.register({ ...calculateTool, enabled: false })
    expect(
      new CentralToolExecutor(registry).getExecutableToolDescriptions().map((tool) => tool.name)
    ).toEqual(['get_current_time'])
  })

  it('returns structured system snapshots and denies application launches before handlers run', async () => {
    const registry = new ToolRegistry()
    registry.register(getSystemInfoTool)
    registry.register(getSystemUsageTool)
    registry.register(listSupportedApplicationsTool)
    registry.register(openApplicationTool)
    const executor = new CentralToolExecutor(registry)
    const info = await executor.execute(request('get_system_info', {}))
    const usage = await executor.execute(request('get_system_usage', {}))
    const applications = await executor.execute(request('list_supported_applications', {}))
    expect(info).toMatchObject({
      ok: true,
      output: expect.objectContaining({
        totalMemoryBytes: expect.any(Number),
        uptimeSeconds: expect.any(Number)
      })
    })
    expect(usage).toMatchObject({
      ok: true,
      output: expect.objectContaining({
        memoryUsagePercent: expect.any(Number),
        alfredProcessRssBytes: expect.any(Number)
      })
    })
    expect(applications).toMatchObject({
      ok: true,
      output: expect.objectContaining({ applications: expect.any(Array) })
    })
    await expect(
      executor.execute(request('open_application', { applicationId: 'notepad' }))
    ).resolves.toMatchObject({ ok: false, category: 'confirmation_unavailable' })
  })

  it('requires a matching one-time approval before executing confirm tools', async () => {
    const registry = new ToolRegistry()
    let executions = 0
    registry.register({
      id: 'confirm_action',
      displayName: 'Confirm action',
      description: 'test',
      inputSchema: z.object({ target: z.string() }).strict(),
      risk: 'confirm',
      enabled: true,
      confirmation: (input) => ({
        action: 'Open test target',
        explanation: 'A test action will run.',
        target: (input as { target: string }).target
      }),
      async execute() {
        executions += 1
        return { completed: true }
      }
    })
    const confirmations = new TestConfirmationProvider()
    const executor = new CentralToolExecutor(
      registry,
      new ExecutionPolicy(),
      undefined,
      5000,
      confirmations
    )
    const result = executor.execute(request('confirm_action', { target: 'Notepad' }))
    await Promise.resolve()
    expect(confirmations.requests).toHaveLength(1)
    expect(executor.getExecutableToolDescriptions().map((tool) => tool.name)).toContain(
      'confirm_action'
    )
    expect(executions).toBe(0)
    expect(confirmations.resolve(confirmations.requests[0]!.id, 'approved')).toBe(true)
    await expect(result).resolves.toMatchObject({ ok: true, output: { completed: true } })
    expect(executions).toBe(1)
    expect(confirmations.resolve(confirmations.requests[0]!.id, 'approved')).toBe(false)
    expect(executions).toBe(1)
  })

  it('fails closed for rejection, cancellation, unavailable providers, and isolated pending requests', async () => {
    const registry = new ToolRegistry()
    let executions = 0
    const confirmTool: ToolDefinition = {
      id: 'confirmed',
      displayName: 'Confirmed',
      description: 'test',
      inputSchema: z.object({ value: z.string() }).strict(),
      risk: 'confirm',
      enabled: true,
      async execute() {
        executions += 1
        return {}
      }
    }
    registry.register(confirmTool)
    const unavailable = new CentralToolExecutor(registry)
    await expect(unavailable.execute(request('confirmed', { value: 'a' }))).resolves.toMatchObject({
      category: 'confirmation_unavailable'
    })
    const confirmations = new TestConfirmationProvider()
    const executor = new CentralToolExecutor(
      registry,
      new ExecutionPolicy(),
      undefined,
      5000,
      confirmations
    )
    const first = executor.execute({
      ...request('confirmed', { value: 'a' }),
      call: { id: 'a', name: 'confirmed', arguments: { value: 'a' } }
    })
    const second = executor.execute({
      ...request('confirmed', { value: 'b' }),
      call: { id: 'b', name: 'confirmed', arguments: { value: 'b' } }
    })
    await Promise.resolve()
    expect(confirmations.requests).toHaveLength(2)
    expect(confirmations.resolve(confirmations.requests[1]!.id, 'denied')).toBe(true)
    expect(confirmations.resolve('unknown', 'approved')).toBe(false)
    expect(confirmations.resolve(confirmations.requests[0]!.id, 'cancelled')).toBe(true)
    await expect(first).resolves.toMatchObject({ category: 'cancelled' })
    await expect(second).resolves.toMatchObject({ category: 'confirmation_denied' })
    expect(executions).toBe(0)
  })

  it('identifies Windows 10 and Windows 11 without inventing a feature update', () => {
    expect(identifyOperatingSystem('Windows_NT', '10.0.19045')).toBe('Windows 10')
    expect(identifyOperatingSystem('Windows_NT', '10.0.26200')).toBe('Windows 11')
    expect(identifyOperatingSystem('Linux', '6.8.0')).toBe('Linux')
  })
})

class TestConfirmationProvider implements ConfirmationProvider {
  readonly requests: ConfirmationRequest[] = []
  private readonly pending = new Map<string, (decision: ConfirmationDecision) => void>()
  isAvailable(): boolean {
    return true
  }
  request(request: ConfirmationRequest): Promise<ConfirmationDecision> {
    this.requests.push(request)
    return new Promise((resolve) => this.pending.set(request.id, resolve))
  }
  resolve(id: string, decision: ConfirmationDecision): boolean {
    const resolve = this.pending.get(id)
    if (resolve === undefined) return false
    this.pending.delete(id)
    resolve(decision)
    return true
  }
}
