import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MessageRecord, QuoteRecord } from '@shared/types'
import type { ChatState } from './useChat'
import { renderMarkdown } from './markdown'
import QuoteChips from './QuoteChips'
import { claimSpeech, speechChunks } from '../reader/ReadAloud'

/** 翻译结果的落盘格式（见 translation-ipc）：成功后可直接收藏，不再联网。 */
export function isTranslationContent(content: string): boolean {
  return /^〔(离线|在线)(翻译|词典)〕/.test(content)
}

function TranslationSpeech({ text }: { text: string }) {
  const [playing, setPlaying] = useState(false)
  const release = useRef<(() => boolean) | null>(null)
  const token = useRef(0)

  function stop(): void {
    token.current++
    if (release.current?.()) window.speechSynthesis?.cancel()
    release.current = null
    setPlaying(false)
  }

  useEffect(() => () => {
    token.current++
    if (release.current?.()) window.speechSynthesis?.cancel()
  }, [])

  function play(): void {
    const chunks = speechChunks(text)
    if (!chunks.length) return
    release.current = claimSpeech(stop)
    const id = ++token.current
    const lang = /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
    const voice = window.speechSynthesis.getVoices().find((item) => item.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()))
    setPlaying(true)
    window.speechSynthesis.cancel()
    function speak(index: number): void {
      if (id !== token.current) return
      if (index === chunks.length) { stop(); return }
      const utterance = new SpeechSynthesisUtterance(chunks[index])
      utterance.lang = lang
      utterance.voice = voice ?? null
      utterance.onend = () => speak(index + 1)
      utterance.onerror = () => { if (id === token.current) stop() }
      window.speechSynthesis.speak(utterance)
    }
    speak(0)
  }

  return <button type="button" className="button--ghost" data-testid="translation-speak"
    disabled={!('speechSynthesis' in window)} aria-label={playing ? '停止朗读原文' : '朗读原文'}
    onClick={playing ? stop : play}>{playing ? '停止朗读' : '🔊 朗读原文'}</button>
}

interface Props {
  chat: ChatState
  quotes: QuoteRecord[]
  onRemoveQuote: (cfiRange: string) => void
  onTranslateQuote: (quote: QuoteRecord) => void
  onNewConversation: () => void
  onAnnotateQuote?: (quote: QuoteRecord) => void
  annotationBusy?: boolean
  annotationEditor?: ReactNode
  vocabCfiRanges?: Set<string>
  vocabBusy?: boolean
  vocabError?: string | null
  onSaveVocab?: (quotes: QuoteRecord[], translation: string) => void
  emptyHint?: string
}

export default function ConversationView({
  chat,
  quotes,
  onRemoveQuote,
  onTranslateQuote,
  onAnnotateQuote,
  annotationBusy,
  annotationEditor,
  vocabCfiRanges,
  vocabBusy,
  vocabError,
  onSaveVocab,
  emptyHint,
  onNewConversation
}: Props) {
  const [text, setText] = useState('')
  const busy = chat.streaming !== null

  // 翻译成功的 assistant 消息，回找它之前最近一条带引用的 user 消息，
  // 拿回当初选中的原文（quote 元数据），与译文配对收藏。
  function sourceQuotesFor(index: number): QuoteRecord[] {
    for (let i = index - 1; i >= 0; i--) {
      const candidate: MessageRecord = chat.messages[i]
      if (candidate.role === 'user' && candidate.quotes.length > 0) return candidate.quotes
      if (candidate.role === 'user') return []
    }
    return []
  }

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
            <p>{emptyHint ?? '选中文字可引用或翻译，也可以直接询问当前内容。'}</p>
          </div>
        )}
        {chat.messages.filter((message) => !busy || message.id !== chat.streamingMessageId).map((message, index) => (
          <article
            key={message.id}
            className={`message message--${message.role}${/^〔(?:离线|在线)词典〕/.test(message.content) ? ' message--dictionary' : ''}`}
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
            {message.role === 'assistant' && isTranslationContent(message.content) && <div className="vocab-save">
              {(() => {
                const original = sourceQuotesFor(index).map((quote) => quote.text).join(' ').trim()
                return original ? <TranslationSpeech text={original} /> : null
              })()}
              {onSaveVocab && (() => {
                const sources = sourceQuotesFor(index)
                if (sources.length === 0 || !sources[0].startCfi) return null
                const saved = sources.some((quote) => vocabCfiRanges?.has(quote.cfiRange))
                return <button type="button" className="button--ghost" data-testid="vocab-save"
                  disabled={busy || vocabBusy || saved}
                  aria-label={saved ? `已收藏「${sources[0].text.slice(0, 20)}」` : `收藏生词「${sources[0].text.slice(0, 20)}」`}
                  onClick={() => onSaveVocab(sources, message.content)}>
                  {saved ? '已收藏 ✓' : '收藏生词'}
                </button>
              })()}
            </div>}
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
        {vocabError && (
          <div className="chat-error" data-testid="vocab-error">
            <span>{vocabError}</span>
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
