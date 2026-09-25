import { useEffect, useState } from 'react'
import type { BookRecord } from '@shared/types'

export function useBookCovers(books: BookRecord[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    const created: string[] = []
    void Promise.all(books.map(async (book): Promise<[string, string] | null> => {
      if (!book.coverPath) return null
      const bytes = await window.api.readCover(book.id).catch(() => null)
      if (!bytes) return null
      return [book.id, URL.createObjectURL(new Blob([bytes]))]
    })).then((entries) => {
      if (cancelled) {
        for (const entry of entries) if (entry) URL.revokeObjectURL(entry[1])
        return
      }
      const next: Record<string, string> = {}
      for (const entry of entries) {
        if (!entry) continue
        next[entry[0]] = entry[1]
        created.push(entry[1])
      }
      setUrls(next)
    })
    return () => {
      cancelled = true
      for (const url of created) URL.revokeObjectURL(url)
    }
  }, [books])

  return urls
}
