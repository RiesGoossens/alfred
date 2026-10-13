import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'

import {
  configureLogger,
  ConversationEngine,
  getLogger,
  loadConfiguration,
  type LlmProviderHealth
} from '@alfred/core'
import { OllamaProvider } from '@alfred/providers'
import {
  createDemonstrationToolExecutor,
  type ConfirmationDecision,
  type ConfirmationProvider,
  type ConfirmationRequest
} from '@alfred/tools'

// Keep the development shell stable on Windows systems where Electron's GPU subprocess is unavailable.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.setPath('userData', join(process.cwd(), 'data', 'electron'))

type OllamaRuntimeStatus = LlmProviderHealth | { readonly checking: true }

let ollamaStatus: OllamaRuntimeStatus = { checking: true }
let mainWindow: BrowserWindow | undefined
let activeConversation:
  { readonly requestId: string; readonly controller: AbortController } | undefined

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = window
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  return window
}

app.whenReady().then(() => {
  const configuration = loadConfiguration()
  configureLogger(configuration)
  const logger = getLogger('desktop')
  const ollamaProvider = new OllamaProvider(configuration.ollama)
  const confirmations = new ElectronConfirmationProvider(
    () => mainWindow,
    getLogger('confirmations')
  )
  const toolExecutor = createDemonstrationToolExecutor(getLogger('tools'), confirmations)
  const conversationEngine = new ConversationEngine(
    ollamaProvider,
    configuration,
    getLogger('conversation'),
    toolExecutor
  )

  ipcMain.handle('alfred:ollama-status', () => ollamaStatus)
  ipcMain.handle('alfred:conversation:send', (event, payload: unknown) => {
    if (!isConversationRequest(payload))
      return { accepted: false, message: 'Invalid conversation request.' }
    if (activeConversation !== undefined)
      return { accepted: false, message: 'ALFRED is already responding.' }

    const controller = new AbortController()
    activeConversation = { requestId: payload.requestId, controller }
    void streamConversation(
      conversationEngine,
      event.sender,
      payload.requestId,
      payload.content,
      controller
    )
    return { accepted: true }
  })
  ipcMain.handle('alfred:conversation:cancel', (_event, requestId: unknown) => {
    if (typeof requestId !== 'string' || activeConversation?.requestId !== requestId) return false
    activeConversation.controller.abort()
    return true
  })
  ipcMain.handle('alfred:confirmation:respond', (event, payload: unknown) =>
    confirmations.respond(event.sender, payload)
  )
  void ollamaProvider.healthCheck().then((status) => {
    ollamaStatus = status
    logger.info({ ollamaAvailable: status.available }, 'Ollama runtime status updated')
  })

  createMainWindow()
  logger.info('ALFRED desktop foundation started')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

class ElectronConfirmationProvider implements ConfirmationProvider {
  private readonly pending = new Map<
    string,
    {
      readonly request: ConfirmationRequest
      readonly webContents: WebContents
      readonly settle: (decision: ConfirmationDecision) => void
    }
  >()

  constructor(
    private readonly window: () => BrowserWindow | undefined,
    private readonly logger = getLogger('confirmations'),
    private readonly timeoutMs = 30000
  ) {}

  isAvailable(): boolean {
    const window = this.window()
    return (
      window !== undefined &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      window.isVisible() &&
      window.isFocused()
    )
  }

  request(request: ConfirmationRequest, signal?: AbortSignal): Promise<ConfirmationDecision> {
    const window = this.window()
    if (window === undefined || !this.isAvailable()) return Promise.resolve('cancelled')
    const webContents = window.webContents
    return new Promise((resolve) => {
      const settle = (decision: ConfirmationDecision) => {
        const pending = this.pending.get(request.id)
        if (pending === undefined) return
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        webContents.removeListener('destroyed', onDestroyed)
        this.pending.delete(request.id)
        resolve(decision)
      }
      const onAbort = () => settle('cancelled')
      const onDestroyed = () => settle('cancelled')
      const timeout = setTimeout(() => settle('expired'), this.timeoutMs)
      this.pending.set(request.id, { request, webContents, settle })
      signal?.addEventListener('abort', onAbort, { once: true })
      webContents.send('alfred:confirmation:request', request)
      webContents.once('destroyed', onDestroyed)
    })
  }

  respond(sender: WebContents, payload: unknown): boolean {
    if (!isConfirmationResponse(payload)) return false
    const pending = this.pending.get(payload.requestId)
    if (pending === undefined || pending.webContents !== sender) return false
    pending.settle(payload.approved ? 'approved' : 'denied')
    this.logger.info(
      { requestId: payload.requestId, toolId: pending.request.toolId, approved: payload.approved },
      'Confirmation response accepted'
    )
    return true
  }
}

async function streamConversation(
  engine: ConversationEngine,
  webContents: WebContents,
  requestId: string,
  content: string,
  controller: AbortController
): Promise<void> {
  try {
    for await (const event of engine.sendMessage(content, controller.signal)) {
      if (!webContents.isDestroyed())
        webContents.send('alfred:conversation:event', { requestId, event })
    }
  } finally {
    if (activeConversation?.requestId === requestId) activeConversation = undefined
  }
}

function isConversationRequest(value: unknown): value is { requestId: string; content: string } {
  if (typeof value !== 'object' || value === null) return false
  const request = value as { requestId?: unknown; content?: unknown }
  return typeof request.requestId === 'string' && typeof request.content === 'string'
}

function isConfirmationResponse(value: unknown): value is { requestId: string; approved: boolean } {
  if (typeof value !== 'object' || value === null) return false
  const response = value as { requestId?: unknown; approved?: unknown }
  return typeof response.requestId === 'string' && typeof response.approved === 'boolean'
}
