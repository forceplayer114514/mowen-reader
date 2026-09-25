import { useState } from 'react'
import type { QuoteRecord } from '@shared/types'
import type { ChatState } from './useChat'
import { renderMarkdown } from './markdown'

interface Props {
  chat: ChatState
  quotes: QuoteRecord[]
  onRemoveQuote: (cfiRange: string) => void
  onTranslateQuote: (quote: QuoteRecord) => void
  onNewConversation: () => void
}

export default function ConversationView({
  chat,
  quotes,
  onRemoveQuote,
  onTranslateQuote,
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
        {chat.messages.map((message) => (
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

      {quotes.length > 0 && (
        <div className="conversation__quotes" aria-label="已选引用">
          {quotes.map((quote) => (
            <span className="quote-chip-wrap" key={quote.cfiRange}>
              <button
                type="button"
                className="quote-chip"
                data-testid="quote-chip"
                aria-label={`移除引用「${quote.text}」`}
                onClick={() => onRemoveQuote(quote.cfiRange)}
              >
                「{quote.text}」 ×
              </button>
              <button
                type="button"
                className="selection-translate button--primary"
                data-testid="quote-translate"
                aria-label={`翻译「${quote.text}」`}
                disabled={busy}
                onClick={() => onTranslateQuote(quote)}
              >
                翻译
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="conversation__composer">
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
