import { useEffect, useRef, useState } from 'react'
import type { AnnotationRecord, QuoteRecord } from '@shared/types'
import { annotationsOnPage } from '../reader/anchor'
import type { VisibleRange } from '../reader/types'
import QuoteChips from './QuoteChips'

export interface AnnotationDraft {
  id: string | null
  quote: QuoteRecord
  chapterLabel: string | null
  content: string
}

interface Props {
  notes: AnnotationRecord[]
  visible: VisibleRange | null
  draft: AnnotationDraft | null
  active: boolean
  busy: boolean
  error: string | null
  quotes: QuoteRecord[]
  chatBusy: boolean
  onEdit: (note: AnnotationRecord) => void
  onLocate: (note: AnnotationRecord) => void
  onDelete: (note: AnnotationRecord) => void
  onContent: (text: string) => void
  onSubmit: () => void
  onCancel: () => void
  onRemoveQuote: (cfiRange: string) => void
  onTranslateQuote: (quote: QuoteRecord) => void
  onAnnotateQuote: (quote: QuoteRecord) => void
}

export default function AnnotationView(props: Props) {
  const { notes, draft, busy } = props
  const [scope, setScope] = useState('page')
  const shown = scope === 'book' ? notes : props.visible
    ? annotationsOnPage(notes, props.visible.startCfi, props.visible.endCfi) : []
  return <section className="conversation annotations" aria-label="图书注释">
    <div className="annotations__toolbar">
      <span>原文顺序 · {shown.length} 条</span>
      <select aria-label="注释范围" value={scope} onChange={(event) => setScope(event.target.value)}>
        <option value="page">当页注释</option><option value="book">全书注释</option>
      </select>
    </div>
    <div className="conversation__messages">
      {!shown.length && <div className="conversation__empty">
        <span>✎</span><strong>把想法留在原文旁</strong>
        <p>划选文字，悬停下方引用并点击“注释”。注释仅保存在本地，不发送给 AI。</p>
      </div>}
      {shown.map((note) => <article key={note.id} data-testid="annotation-card"
        onClick={() => props.onLocate(note)}
        className={`annotation-card${draft?.id === note.id ? ' annotation-card--active' : ''}`}>
        <div className="annotation-card__head" onClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) event.stopPropagation()
        }}>
          <button type="button" className="annotation-card__number" title="定位原文"
            aria-label={`定位注释 ${notes.indexOf(note) + 1}`} onClick={() => props.onLocate(note)}>
            {notes.indexOf(note) + 1}
          </button>
          <small>{note.chapterLabel ?? '正文'}</small>
          <button type="button" className="button--ghost" data-testid="annotation-edit" disabled={busy}
            onClick={() => props.onEdit(note)}>编辑</button>
          <button type="button" className="button--ghost" data-testid="annotation-delete" disabled={busy}
            aria-label={`删除注释 ${notes.indexOf(note) + 1}`} onClick={() => props.onDelete(note)}>×</button>
        </div>
        <button type="button" className="annotation-card__body" data-testid="annotation-locate"
          aria-label={`跳转到注释 ${notes.indexOf(note) + 1} 的原文`} title="点击定位原文">
          <span className="annotation-card__quote">{note.quote}</span>
          <span className="annotation-card__content">{note.content}</span>
        </button>
      </article>)}
    </div>
    <QuoteChips quotes={props.quotes} busy={props.chatBusy} annotationBusy={busy} onRemove={props.onRemoveQuote}
      onTranslate={props.onTranslateQuote} onAnnotate={props.onAnnotateQuote} />
    {props.active && <AnnotationComposer {...props} />}
  </section>
}

export function AnnotationComposer(props: Pick<Props, 'notes' | 'draft' | 'busy' | 'active' | 'error' | 'onContent' | 'onSubmit' | 'onCancel'>) {
  const { notes, draft, busy, active } = props
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (active && draft) inputRef.current?.focus()
  }, [active, draft?.id, draft?.quote.cfiRange])
  return <>
    {props.error && <div className="chat-error" role="alert" data-testid="annotation-error">{props.error}</div>}
    {draft && <div className="annotation-target" data-testid="annotation-target">
      <div><strong>{draft.id ? `编辑注释 ${notes.findIndex((note) => note.id === draft.id) + 1}` : '新建注释'}</strong>
        <button type="button" className="button--ghost" disabled={busy} onClick={props.onCancel}>取消</button></div>
      <blockquote>{draft.quote.text}</blockquote>
    </div>}
    <div className="conversation__composer annotations__composer">
      <textarea ref={inputRef} data-testid="annotation-input" value={draft?.content ?? ''}
        disabled={!draft || busy} rows={2} maxLength={20000}
        placeholder={draft ? '写下你的注释…' : '先选择一段原文，再点击“注释”'}
        onChange={(event) => props.onContent(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            props.onSubmit()
          }
        }} />
      <button type="button" className="button--primary" data-testid="annotation-submit"
        disabled={busy || !draft?.content.trim()} onClick={props.onSubmit}>{busy ? '提交中…' : '提交'}</button>
    </div>
  </>
}
