export interface BookRecord {
  id: string
  title: string
  author: string | null
  coverPath: string | null
  filePath: string
  sourcePath: string
  addedAt: number
  lastReadCfi: string | null
  lastReadAt: number | null
}

export interface ImportedFile {
  id: string
  filePath: string
}

export interface FinishImportInput {
  id: string
  sourcePath: string
  title: string
  author: string | null
  coverBytes: number[] | null
}
