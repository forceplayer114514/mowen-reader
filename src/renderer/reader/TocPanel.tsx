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
          const active = item.href.split('#')[0] === currentHref.split('#')[0]
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
