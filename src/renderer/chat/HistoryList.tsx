import type { ConversationWithCount } from '@shared/types'

interface Props {
  conversations: ConversationWithCount[]
  activeId: string | null
  onSelect: (id: string) => void
  onLocate: (startCfi: string) => void
  onDelete: (id: string) => void
}

export default function HistoryList({ conversations, activeId, onSelect, onLocate, onDelete }: Props) {
  if (conversations.length === 0) return null
  return (
    <div className="history" aria-label="本章对话">
      {conversations.map((conversation) => (
        <div className="history__row" key={conversation.id}>
          <button
            type="button"
            className={`history__entry${activeId === conversation.id ? ' history__entry--active' : ''}`}
            data-testid="history-entry"
            onClick={() => onSelect(conversation.id)}
          >
            <span>「{conversation.excerpt}」</span>
            <small>{conversation.messageCount} 条</small>
          </button>
          <button
            type="button"
            className="history__locate"
            aria-label={`定位对话「${conversation.excerpt}」`}
            title="定位原文"
            onClick={() => onLocate(conversation.startCfi)}
          >
            ↗
          </button>
          <button
            type="button"
            className="history__delete"
            data-testid="history-delete"
            aria-label={`删除对话「${conversation.excerpt}」`}
            title="删除对话"
            onClick={() => onDelete(conversation.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
