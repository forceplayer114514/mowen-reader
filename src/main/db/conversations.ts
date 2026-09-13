import type {
  ConversationRecord,
  ConversationWithCount,
  MessageRecord,
  QuoteRecord
} from '../../shared/types'
import type { Db } from './index'

interface ConvRow {
  id: string
  book_id: string
  start_cfi: string
  end_cfi: string
  merged_end_cfi: string | null
  chapter_label: string | null
  excerpt: string
  created_at: number
}

function toConv(row: ConvRow): ConversationRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    startCfi: row.start_cfi,
    endCfi: row.end_cfi,
    mergedEndCfi: row.merged_end_cfi,
    chapterLabel: row.chapter_label,
    excerpt: row.excerpt,
    createdAt: row.created_at
  }
}

const CONV_COLUMNS =
  'id, book_id, start_cfi, end_cfi, merged_end_cfi, chapter_label, excerpt, created_at'

export function insertConversation(db: Db, c: ConversationRecord): void {
  db.prepare(
    `INSERT INTO conversations (${CONV_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    c.id,
    c.bookId,
    c.startCfi,
    c.endCfi,
    c.mergedEndCfi,
    c.chapterLabel,
    c.excerpt,
    c.createdAt
  )
}

export function getConversation(db: Db, id: string): ConversationRecord | null {
  const row = db
    .prepare(`SELECT ${CONV_COLUMNS} FROM conversations WHERE id = ?`)
    .get(id) as ConvRow | undefined
  return row ? toConv(row) : null
}

export function updateConversationMerge(db: Db, id: string, mergedEndCfi: string | null): void {
  db.prepare('UPDATE conversations SET merged_end_cfi = ? WHERE id = ?').run(mergedEndCfi, id)
}

export function listConversations(db: Db, bookId: string): ConversationWithCount[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.book_id, c.start_cfi, c.end_cfi, c.merged_end_cfi,
              c.chapter_label, c.excerpt, c.created_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
        WHERE c.book_id = ?
        ORDER BY c.created_at ASC`
    )
    .all(bookId) as unknown as (ConvRow & { message_count: number })[]
  return rows.map((row) => ({ ...toConv(row), messageCount: row.message_count }))
}

export function countConversations(db: Db, bookId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE book_id = ?')
    .get(bookId) as { n: number }
  return row.n
}

export function deleteConversations(db: Db, ids: string[]): void {
  if (ids.length === 0) return
  const holes = ids.map(() => '?').join(', ')
  // messages 上的外键带 ON DELETE CASCADE,连带删除由数据库完成
  db.prepare(`DELETE FROM conversations WHERE id IN (${holes})`).run(...ids)
}

interface MsgRow {
  id: string
  conversation_id: string
  role: string
  content: string
  quotes: string
  created_at: number
}

function parseQuotes(raw: string): QuoteRecord[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as QuoteRecord[]) : []
  } catch {
    return []
  }
}

export function insertMessage(db: Db, m: MessageRecord): void {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, quotes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(m.id, m.conversationId, m.role, m.content, JSON.stringify(m.quotes), m.createdAt)
}

export function listMessages(db: Db, conversationId: string): MessageRecord[] {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, role, content, quotes, created_at
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(conversationId) as unknown as MsgRow[]
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    quotes: parseQuotes(row.quotes),
    createdAt: row.created_at
  }))
}
