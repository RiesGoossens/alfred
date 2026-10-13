import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('alfred', {
  foundation: true,
  getOllamaStatus: () => ipcRenderer.invoke('alfred:ollama-status'),
  sendConversationMessage: (requestId: string, content: string) =>
    ipcRenderer.invoke('alfred:conversation:send', { requestId, content }),
  cancelConversation: (requestId: string) =>
    ipcRenderer.invoke('alfred:conversation:cancel', requestId),
  respondToConfirmation: (requestId: string, approved: boolean) =>
    ipcRenderer.invoke('alfred:confirmation:respond', { requestId, approved }),
  onConversationEvent: (listener: (payload: unknown) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) =>
      listener(payload)
    ipcRenderer.on('alfred:conversation:event', wrappedListener)
    return () => ipcRenderer.removeListener('alfred:conversation:event', wrappedListener)
  },
  onConfirmationRequest: (listener: (payload: unknown) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) =>
      listener(payload)
    ipcRenderer.on('alfred:confirmation:request', wrappedListener)
    return () => ipcRenderer.removeListener('alfred:confirmation:request', wrappedListener)
  }
})
