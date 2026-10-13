import type { ConversationEvent, LlmProviderHealth } from '@alfred/core'

declare global {
  interface Window {
    alfred: {
      foundation: true
      getOllamaStatus: () => Promise<LlmProviderHealth | { checking: true }>
      sendConversationMessage: (
        requestId: string,
        content: string
      ) => Promise<{ accepted: boolean; message?: string }>
      cancelConversation: (requestId: string) => Promise<boolean>
      respondToConfirmation: (requestId: string, approved: boolean) => Promise<boolean>
      onConversationEvent: (
        listener: (payload: { requestId: string; event: ConversationEvent }) => void
      ) => () => void
      onConfirmationRequest: (
        listener: (payload: {
          id: string
          toolName: string
          action: string
          target?: string
          explanation: string
        }) => void
      ) => () => void
    }
  }
}

export {}
