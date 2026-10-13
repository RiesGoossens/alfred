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
import { createDemonstrationToolExecutor } from '@alfred/tools'

// Keep the development shell stable on Windows systems where Electron's GPU subprocess is unavailable.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.setPath('userData', join(process.cwd(), 'data', 'electron'))

type OllamaRuntimeStatus = LlmProviderHealth | { readonly checking: true }

let ollamaStatus: OllamaRuntimeStatus = { checking: true }
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

  return window
}

app.whenReady().then(() => {
  const configuration = loadConfiguration()
  configureLogger(configuration)
  const logger = getLogger('desktop')
  const ollamaProvider = new OllamaProvider(configuration.ollama)
  const toolExecutor = createDemonstrationToolExecutor(getLogger('tools'))
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
