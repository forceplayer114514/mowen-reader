import { normalizeChapterHref } from './href'
import type { BookmarkRecord } from '@shared/types'
import type { TocItem } from './types'

interface Props {
  items: TocItem[]
  currentHref: string
  bookmarks?: BookmarkRecord[]
  deletingBookmarkId?: string | null
  onDeleteBookmark: (id: string) => void
  onJump: (href: string) => void
  onClose: () => void
}

export default function TocPanel({ items, currentHref, bookmarks = [], deletingBookmarkId, onDeleteBookmark, onJump, onClose }: Props) {
  return (
    <div className="toc" data-testid="toc">
      <div className="toc__head">
        <div>
          <span className="eyebrow">CONTENTS</span>
          <strong>目录</strong>
        </div>
        <button className="button--icon" aria-label="关闭目录" onClick={onClose}>×</button>
      </div>
      {bookmarks.length > 0 && (
        <section className="toc__bookmarks" aria-label="书签">
          <span className="eyebrow">BOOKMARKS</span>
          <strong>书签</strong>
          {bookmarks.map((bookmark) => (
            <div className="toc__bookmark-row" key={bookmark.id}>
              <button
                type="button"
                className="toc__bookmark"
                data-testid="bookmark-entry"
                onClick={() => onJump(bookmark.startCfi)}
              >
                <span>{bookmark.chapterLabel ?? '未命名章节'}</span>
                <small>{bookmark.excerpt || '书页开头'}</small>
              </button>
              <button type="button" className="button--ghost toc__bookmark-delete" data-testid="bookmark-delete"
                aria-label={`删除书签：${bookmark.chapterLabel ?? '未命名章节'}`} title="删除书签"
                disabled={!!deletingBookmarkId} onClick={() => onDeleteBookmark(bookmark.id)}>
                {deletingBookmarkId === bookmark.id ? '删除中…' : '删除'}
              </button>
            </div>
          ))}
        </section>
      )}
      <ul className="toc__list">
        {items.map((item, i) => {
          // 和 engine.ts 里匹配当前章节用的是同一套归一化逻辑,原因见 href.ts 的注释:
          // 原始字符串比较在目录链接带 ../ 前缀时会误判成"不是当前章节"。
          const active = normalizeChapterHref(item.href) === normalizeChapterHref(currentHref)
          return (
            <li key={`${item.href}-${i}`}>
              <button
                className={`toc__item${active ? ' toc__item--active' : ''}`}
                style={{ paddingLeft: 10 + item.depth * 16 }}
                onClick={() => onJump(item.href)}
              >
                {item.label || '(无标题)'}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
