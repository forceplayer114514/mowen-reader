import { useState } from 'react'
import type { BookRecord } from '@shared/types'
import LibraryView from './library/LibraryView'
import ConversationsView from './library/ConversationsView'
import ReaderView from './reader/ReaderView'
import SettingsView from './settings/SettingsView'

export default function App() {
  const [reading, setReading] = useState<BookRecord | null>(null)
  const [page, setPage] = useState<'library' | 'settings' | 'conversations'>('library')

  if (reading) return <ReaderView book={reading} onBack={() => setReading(null)} />
  if (page === 'settings') return <SettingsView onBack={() => setPage('library')} />
  if (page === 'conversations') return <ConversationsView onBack={() => setPage('library')} />
  return (
    <LibraryView
      onOpenBook={setReading}
      onOpenSettings={() => setPage('settings')}
      onOpenConversations={() => setPage('conversations')}
    />
  )
}
