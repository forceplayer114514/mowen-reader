import { useState } from 'react'
import type { BookRecord } from '@shared/types'
import LibraryView from './library/LibraryView'

export default function App() {
  const [reading, setReading] = useState<BookRecord | null>(null)

  if (reading) {
    return (
      <div style={{ padding: 24 }}>
        <button onClick={() => setReading(null)}>← 回到书架</button>
        <h2>{reading.title}</h2>
      </div>
    )
  }

  return <LibraryView onOpenBook={setReading} />
}
