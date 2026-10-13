import { describe, expect, it } from 'vitest'

import type { ToolDefinition } from '@alfred/tools'
import {
  calculateTool,
  CentralToolExecutor,
  ExecutionPolicy,
  getSystemInfoTool,
  getSystemUsageTool,
  getCurrentTimeTool,
  listSupportedApplicationsTool,
  openApplicationTool,
  ToolRegistry
} from '@alfred/tools'
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
      category: 'permission_denied'
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
    ).resolves.toMatchObject({ ok: false, category: 'permission_denied' })
  })
})
