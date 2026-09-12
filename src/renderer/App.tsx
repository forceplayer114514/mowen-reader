import { useState } from 'react'
import type { BookRecord } from '@shared/types'
import LibraryView from './library/LibraryView'
import ReaderView from './reader/ReaderView'

export default function App() {
  const [reading, setReading] = useState<BookRecord | null>(null)

  if (reading) return <ReaderView book={reading} onBack={() => setReading(null)} />
  return <LibraryView onOpenBook={setReading} />
}
