import { normalizeChapterHref } from './href'
import type { TocItem } from './types'

interface Props {
  items: TocItem[]
  currentHref: string
  onJump: (href: string) => void
  onClose: () => void
}

export default function TocPanel({ items, currentHref, onJump, onClose }: Props) {
  return (
    <div className="toc" data-testid="toc">
      <div className="toc__head">
        <strong>目录</strong>
        <button onClick={onClose}>关闭</button>
      </div>
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
