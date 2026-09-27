import { useState, type ReactNode } from 'react'
import type { QuoteRecord } from '@shared/types'
import type { ChatState } from './useChat'
import { renderMarkdown } from './markdown'
import QuoteChips from './QuoteChips'

interface Props {
  chat: ChatState
  quotes: QuoteRecord[]
  onRemoveQuote: (cfiRange: string) => void
  onTranslateQuote: (quote: QuoteRecord) => void
  onNewConversation: () => void
  onAnnotateQuote?: (quote: QuoteRecord) => void
  annotationBusy?: boolean
  annotationEditor?: ReactNode
}

export default function ConversationView({
  chat,
  quotes,
  onRemoveQuote,
  onTranslateQuote,
  onAnnotateQuote,
  annotationBusy,
  annotationEditor,
  onNewConversation
}: Props) {
  const [text, setText] = useState('')
  const busy = chat.streaming !== null

  async function submit(): Promise<void> {
    const value = text.trim()
    if (!value || busy) return
    setText('')
    await chat.send(value)
  }

  return (
    <section className="conversation" aria-label="当前对话">
      <div className="conversation__messages">
        {chat.messages.length === 0 && chat.streaming === null && (
          <div className="conversation__empty">
            <span>✦</span>
            <strong>从当前位置开始提问</strong>
            <p>选中文字可引用或翻译，也可以直接询问当前内容。</p>
          </div>
        )}
        {chat.messages.filter((message) => !busy || message.id !== chat.streamingMessageId).map((message) => (
          <article
            key={message.id}
            className={`message message--${message.role}`}
            data-testid={`message-${message.role}`}
          >
            {message.role === 'user' && message.quotes.length > 0 && (
              <div className="message__quotes">
                {message.quotes.map((quote) => (
                  <span key={quote.cfiRange}>「{quote.text}」</span>
                ))}
              </div>
            )}
            {message.role === 'assistant' ? (
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
            ) : (
              <p>{message.content}</p>
            )}
          </article>
        ))}
        {chat.streaming !== null && (
          <article className="message message--assistant" data-testid="message-assistant">
            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(chat.streaming) }} />
          </article>
        )}
        {chat.error && (
          <div className="chat-error" data-testid="chat-error">
            <span>{chat.error}</span>
            <button type="button" data-testid="chat-retry" onClick={() => void chat.retry()}>
              重试
            </button>
          </div>
        )}
      </div>

      <QuoteChips quotes={quotes} busy={busy} annotationBusy={annotationBusy} onRemove={onRemoveQuote}
        onTranslate={onTranslateQuote} onAnnotate={onAnnotateQuote} />

      {annotationEditor}
      <div className="conversation__composer" hidden={!!annotationEditor}>
        <textarea
          data-testid="chat-input"
          value={text}
          disabled={busy}
          placeholder="问点什么…"
          rows={2}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        {busy ? (
          <button type="button" className="button--secondary" data-testid="chat-stop" onClick={chat.stop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="button--primary"
            data-testid="chat-send"
            disabled={text.trim().length === 0}
            onClick={() => void submit()}
          >
            发送
          </button>
        )}
        <button
          type="button"
          className="button--icon"
          data-testid="new-conversation"
          disabled={busy}
          onClick={onNewConversation}
          aria-label="新建对话"
          title="新建对话"
        >
          ＋
        </button>
      </div>
    </section>
  )
}
