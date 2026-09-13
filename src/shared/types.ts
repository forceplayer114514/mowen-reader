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
  // 走 ArrayBuffer 而不是 number[]:后者会把一张几百 KB 的封面拆成几十万个
  // JavaScript 数组元素,序列化和跨进程传输的开销随之放大好几倍。
  coverBytes: ArrayBuffer | null
}
