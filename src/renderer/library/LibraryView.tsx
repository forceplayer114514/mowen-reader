import { useCallback, useEffect, useState } from 'react'
import type { BookRecord, ImportedFile } from '@shared/types'
import { extractMetadata } from '../reader/metadata'

interface Props {
  onOpenBook: (book: BookRecord) => void
}

export default function LibraryView({ onOpenBook }: Props) {
  const [books, setBooks] = useState<BookRecord[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBooks(await window.api.listBooks())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 把"已经复制进库、但还没写数据库记录"的文件挨个读元数据、落库。
  // 两条导入入口(stageImport 走对话框选出的路径,stageDroppedFiles 走拖拽)
  // 各自把路径喂给主进程换出 staged 列表后,都走这同一段收尾逻辑。
  const importStaged = useCallback(
    async (staged: ImportedFile[], sourcePaths: string[]) => {
      if (staged.length === 0) return
      try {
        for (let i = 0; i < staged.length; i++) {
          setBusy(`正在导入 ${i + 1}/${staged.length}`)
          const file = staged[i]
          // 此刻还没入库,只能按 id 读刚复制进库的文件
          const bytes = await window.api.readStagedFile(file.id)
          const meta = await extractMetadata(bytes)
          await window.api.finishImport({
            id: file.id,
            sourcePath: sourcePaths[i],
            title: meta.title,
            author: meta.author,
            coverBytes: meta.coverBytes
          })
        }
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : '导入失败')
      } finally {
        setBusy(null)
      }
    },
    [refresh]
  )

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return
      setError(null)
      try {
        const staged = await window.api.stageImport(paths)
        await importStaged(staged, paths)
      } catch (err) {
        setError(err instanceof Error ? err.message : '导入失败')
        setBusy(null)
      }
    },
    [importStaged]
  )

  const onPickFiles = useCallback(async () => {
    await importPaths(await window.api.pickEpubFiles())
  }, [importPaths])

  const onPickFolder = useCallback(async () => {
    const dir = await window.api.pickFolder()
    if (!dir) return
    setBusy('正在扫描文件夹')
    try {
      const found = await window.api.scanFolder(dir)
      if (found.length === 0) {
        setError('这个文件夹里没有发现未导入的 EPUB')
        return
      }
      await importPaths(found)
    } catch (err) {
      setError(err instanceof Error ? err.message : '扫描失败')
    } finally {
      setBusy(null)
    }
  }, [importPaths])

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const paths: string[] = []
      for (const file of Array.from(e.dataTransfer.files)) {
        const path = window.api.pathForFile(file)
        if (path && path.toLowerCase().endsWith('.epub')) paths.push(path)
      }
      if (paths.length === 0) {
        setError('拖进来的文件里没有 EPUB')
        return
      }
      setError(null)
      try {
        // 拖拽来的路径合法地来自渲染层本身,过不了 stageImport 背后那道
        // 只认主进程自己发出路径的闸门,要走专门给拖拽开的 stageDroppedFiles。
        const staged = await window.api.stageDroppedFiles(paths)
        await importStaged(staged, paths)
      } catch (err) {
        setError(err instanceof Error ? err.message : '导入失败')
        setBusy(null)
      }
    },
    [importStaged]
  )

  return (
    <div
      className={`library${dragging ? ' dropzone--active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-testid="library"
    >
      <div className="library__bar">
        <button onClick={onPickFiles} data-testid="pick-files">
          添加 EPUB
        </button>
        <button onClick={onPickFolder} data-testid="pick-folder">
          扫描文件夹
        </button>
        {busy && <span className="book-card__author">{busy}…</span>}
        {error && <span style={{ color: 'var(--danger)' }}>{error}</span>}
      </div>

      {books.length === 0 ? (
        <p className="empty">书架是空的。把 EPUB 文件拖进这个窗口,或者点上面的按钮。</p>
      ) : (
        <div className="library__grid">
          {books.map((book) => (
            <div
              key={book.id}
              className="book-card"
              data-testid="book-card"
              onClick={() => onOpenBook(book)}
            >
              <div className="book-card__cover">
                {book.coverPath ? (
                  <img
                    src={`file://${book.coverPath}`}
                    alt={book.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  book.title
                )}
              </div>
              <div className="book-card__title">{book.title}</div>
              <div className="book-card__author">{book.author ?? '佚名'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
