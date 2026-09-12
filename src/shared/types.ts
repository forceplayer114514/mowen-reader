export interface BookRecord {
  id: string
  title: string
  author: string | null
  coverPath: string | null
  filePath: string
  addedAt: number
  lastReadCfi: string | null
  lastReadAt: number | null
}

export interface ImportedFile {
  id: string
  filePath: string
}
