import type { QuoteRecord } from '@shared/types'

interface Props {
  quotes: QuoteRecord[]
  busy?: boolean
  annotationBusy?: boolean
  onRemove: (cfiRange: string) => void
  onTranslate: (quote: QuoteRecord) => void
  onAnnotate?: (quote: QuoteRecord) => void
}

export default function QuoteChips({ quotes, busy, annotationBusy, onRemove, onTranslate, onAnnotate }: Props) {
  if (!quotes.length) return null
  return <div className="conversation__quotes" aria-label="已选引用">
    {quotes.map((quote) => <span className="quote-chip-wrap" key={quote.cfiRange}>
      <button type="button" className="quote-chip" data-testid="quote-chip"
        aria-label={`移除引用「${quote.text}」`} onClick={() => onRemove(quote.cfiRange)}>
        「{quote.text}」 ×
      </button>
      <span className="selection-actions">
        <button type="button" className="button--primary" data-testid="quote-translate"
          aria-label={`翻译「${quote.text}」`} disabled={busy} onClick={() => onTranslate(quote)}>翻译</button>
        {onAnnotate && <button type="button" data-testid="quote-annotate"
          disabled={annotationBusy} title={annotationBusy ? '正在读取或保存注释…' : '添加原文注释'}
          aria-label={`注释「${quote.text}」`} onClick={() => onAnnotate(quote)}>注释</button>}
      </span>
    </span>)}
  </div>
}
