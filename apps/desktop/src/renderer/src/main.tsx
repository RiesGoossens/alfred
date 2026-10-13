import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import './styles.css'

interface DisplayMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'error'
  readonly content: string
}

function FoundationApp() {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [activeRequestId, setActiveRequestId] = useState<string>()
  const [startupError, setStartupError] = useState<string>()

  useEffect(() => {
    const bridge = window.alfred
    if (bridge === undefined) {
      setStartupError('The secure ALFRED desktop bridge did not load. Restart the application.')
      return
    }

    try {
      return bridge.onConversationEvent((payload) => {
        const event = payload.event
        if (event.type === 'assistant-delta') {
          setMessages((current) => appendAssistantDelta(current, payload.requestId, event.content))
          return
        }
        if (event.type === 'assistant-complete') {
          setActiveRequestId(undefined)
          return
        }
        setMessages((current) => [
          ...current,
          { id: `error-${payload.requestId}`, role: 'error', content: event.error.message }
        ])
        setActiveRequestId(undefined)
      })
    } catch {
      setStartupError('ALFRED could not initialize its conversation connection.')
      return
    }
  }, [])

  async function sendMessage(): Promise<void> {
    const content = input.trim()
    if (content.length === 0 || activeRequestId !== undefined) return

    const requestId = crypto.randomUUID()
    setMessages((current) => [...current, { id: requestId, role: 'user', content }])
    setInput('')
    setActiveRequestId(requestId)

    const bridge = window.alfred
    if (bridge === undefined) {
      setStartupError('The secure ALFRED desktop bridge did not load. Restart the application.')
      setActiveRequestId(undefined)
      return
    }

    const result = await bridge.sendConversationMessage(requestId, content)
    if (!result.accepted) {
      setMessages((current) => [
        ...current,
        {
          id: `error-${requestId}`,
          role: 'error',
          content: result.message ?? 'Unable to send message.'
        }
      ])
      setActiveRequestId(undefined)
    }
  }

  async function cancelMessage(): Promise<void> {
    if (activeRequestId !== undefined) await window.alfred?.cancelConversation(activeRequestId)
  }

  return (
    <main>
      <p className="eyebrow">ALFRED — LOCAL CONVERSATION</p>
      <h1>Text conversation test</h1>
      {startupError === undefined ? null : <p className="startup-error">{startupError}</p>}
      <section className="conversation" aria-live="polite">
        {messages.length === 0 ? <p>Send a message to begin a local conversation.</p> : null}
        {messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <strong>
              {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'ALFRED' : 'Error'}
            </strong>
            <p>{message.content}</p>
          </article>
        ))}
      </section>
      <section className="composer">
        <textarea
          aria-label="Message ALFRED"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void sendMessage()
            }
          }}
          placeholder="Message ALFRED"
          rows={3}
        />
        <div className="actions">
          <button
            disabled={activeRequestId !== undefined || startupError !== undefined}
            onClick={() => void sendMessage()}
            type="button"
          >
            Send
          </button>
          <button
            disabled={activeRequestId === undefined}
            onClick={() => void cancelMessage()}
            type="button"
          >
            Stop
          </button>
        </div>
      </section>
    </main>
  )
}

function appendAssistantDelta(
  messages: DisplayMessage[],
  requestId: string,
  content: string
): DisplayMessage[] {
  const assistantMessageId = `assistant-${requestId}`
  const existing = messages.find((message) => message.id === assistantMessageId)
  if (existing === undefined)
    return [...messages, { id: assistantMessageId, role: 'assistant', content }]
  return messages.map((message) =>
    message.id === assistantMessageId ? { ...message, content: message.content + content } : message
  )
}

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('ALFRED renderer root element was not found.')

createRoot(rootElement).render(
  <StrictMode>
    <FoundationApp />
  </StrictMode>
)
