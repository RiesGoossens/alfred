import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('alfred', {
  foundation: true,
  getOllamaStatus: () => ipcRenderer.invoke('alfred:ollama-status'),
  sendConversationMessage: (requestId: string, content: string) =>
    ipcRenderer.invoke('alfred:conversation:send', { requestId, content }),
  cancelConversation: (requestId: string) =>
    ipcRenderer.invoke('alfred:conversation:cancel', requestId),
  onConversationEvent: (listener: (payload: unknown) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) =>
      listener(payload)
    ipcRenderer.on('alfred:conversation:event', wrappedListener)
    return () => ipcRenderer.removeListener('alfred:conversation:event', wrappedListener)
  }
})
