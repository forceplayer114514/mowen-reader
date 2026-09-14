import type { ConversationWithCount } from '@shared/types'

interface Props {
  conversations: ConversationWithCount[]
  activeId: string | null
  onSelect: (id: string) => void
}

export default function HistoryList({ conversations, activeId, onSelect }: Props) {
  if (conversations.length === 0) return null
  return (
    <div className="history" aria-label="本章历史对话">
      {conversations.map((conversation) => (
        <button
          type="button"
          key={conversation.id}
          className={`history__entry${activeId === conversation.id ? ' history__entry--active' : ''}`}
          data-testid="history-entry"
          onClick={() => onSelect(conversation.id)}
        >
          <span>
            {conversation.chapterLabel ?? '未命名章节'} · 「{conversation.excerpt}」
          </span>
          <small>{conversation.messageCount} 条消息</small>
        </button>
      ))}
    </div>
  )
}
