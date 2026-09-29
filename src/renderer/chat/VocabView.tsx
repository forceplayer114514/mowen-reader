import { useMemo } from 'react'
import type { VocabRecord } from '@shared/vocab-types'
import { compareCfi } from '../reader/cfi'

interface Props {
  vocabs: VocabRecord[]
  busy: boolean
  error: string | null
  onLocate: (vocab: VocabRecord) => void
  onDelete: (vocab: VocabRecord) => void
}

export default function VocabView({ vocabs, busy, error, onLocate, onDelete }: Props) {
  const sorted = useMemo(() => [...vocabs].sort((a, b) => {
    try { return compareCfi(a.startCfi, b.startCfi) || a.createdAt - b.createdAt || a.id.localeCompare(b.id) }
    catch { return a.createdAt - b.createdAt }
  }), [vocabs])

  return <section className="conversation vocab" aria-label="生词收藏">
    {error && <div className="chat-error" role="alert" data-testid="vocab-error">{error}</div>}
    <div className="conversation__messages">
      {!sorted.length && <div className="conversation__empty">
        <span>词</span><strong>收藏翻译过的生词句</strong>
        <p>翻译成功后，在译文下方点击“收藏生词”。只保存在本地，不会再联网。</p>
      </div>}
      {sorted.map((vocab) => <article key={vocab.id} className="annotation-card vocab-card" data-testid="vocab-card">
        <div className="annotation-card__head">
          <small>{vocab.chapterLabel ?? '正文'}</small>
          <button type="button" className="button--ghost" data-testid="vocab-locate"
            aria-label={`回到「${vocab.sourceText.slice(0, 20)}」的原文`} onClick={() => onLocate(vocab)}>定位原文</button>
          <button type="button" className="button--ghost" data-testid="vocab-delete" disabled={busy}
            aria-label={`删除生词「${vocab.sourceText.slice(0, 20)}」`} onClick={() => onDelete(vocab)}>×</button>
        </div>
        <span className="annotation-card__quote">「{vocab.sourceText}」</span>
        <span className="annotation-card__content vocab-card__translation">{vocab.translation}</span>
      </article>)}
    </div>
  </section>
}
