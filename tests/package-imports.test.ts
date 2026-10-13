import { describe, expect, it } from 'vitest'

import * as core from '@alfred/core'
import * as providers from '@alfred/providers'
import * as tools from '@alfred/tools'
import * as voice from '@alfred/voice'
import { OllamaProvider } from '@alfred/providers'

describe('public package entry points', () => {
  it('exports the shared foundation modules', () => {
    expect(core.parseConfiguration).toBeTypeOf('function')
    expect(providers).toBeTypeOf('object')
    expect(tools).toBeTypeOf('object')
    expect(voice).toBeTypeOf('object')
    expect(OllamaProvider).toBeTypeOf('function')
  })
})
