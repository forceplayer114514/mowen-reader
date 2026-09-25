import { useCallback, useEffect, useState } from 'react'
import type { BookRecord, ImportedFile } from '@shared/types'
import { extractMetadata } from '../reader/metadata'
import appIcon from '../assets/mowen-icon.png'
import ConfirmDialog from '../ConfirmDialog'
import { useBookCovers } from './useBookCovers'

interface Props {
  onOpenBook: (book: BookRecord) => void
  onOpenSettings?: () => void
  onOpenConversations?: () => void
}

type Stager = (sourcePaths: string[]) => Promise<ImportedFile[]>

export default function LibraryView({ onOpenBook, onOpenSettings, onOpenConversations }: Props) {
  const [books, setBooks] = useState<BookRecord[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const coverUrls = useBookCovers(books)
  // 等待用户确认删除的那本书;非 null 时弹出确认框。删除会连带清掉用户复制
  // 进库的文件副本,不可撤销,所以必须先经过这一步确认,不能点了就删。
  const [pendingDelete, setPendingDelete] = useState<BookRecord | null>(null)
  const [deleting, setDeleting] = useState(false)

  const refresh = useCallback(async () => {
    setBooks(await window.api.listBooks())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 每本书独立完成"复制进库 -> 读元数据 -> 落库"这一整套动作,失败了
  // 只清理这一本自己复制出来的文件,不影响其它书——这样一批里有几本
  // 坏文件,不会连累前面已经导入成功的书变成孤儿文件,也不会让它们
  // 因为后面抛错而白导入一遍却不落库。
  const importOne = useCallback(
    async (sourcePath: string, stage: Stager): Promise<string | null> => {
      let staged: ImportedFile | null = null
      try {
        const [file] = await stage([sourcePath])
        staged = file
        const bytes = await window.api.readStagedFile(file.id)
        const meta = await extractMetadata(bytes)
        await window.api.finishImport({
          id: file.id,
          sourcePath,
          title: meta.title,
          author: meta.author,
          coverBytes: meta.coverBytes
        })
        return null
      } catch (err) {
        if (staged) {
          // 清理本身失败也不该盖掉真正的导入错误,静默即可。
          await window.api.discardStagedFile(staged.id).catch(() => {})
        }
        return err instanceof Error ? err.message : '导入失败'
      }
    },
    []
  )

  const importPaths = useCallback(
    async (paths: string[], stage: Stager) => {
      if (paths.length === 0) return
      setError(null)
      let succeeded = 0
      const failures: string[] = []
      try {
        for (let i = 0; i < paths.length; i++) {
          setBusy(`正在导入 ${i + 1}/${paths.length}`)
          const failure = await importOne(paths[i], stage)
          if (failure) failures.push(failure)
          else succeeded++
        }
      } finally {
        setBusy(null)
        // 不管是全部成功、部分失败还是全部失败,已经落库的书都要露出来。
        await refresh()
      }
      if (failures.length > 0) {
        setError(
          succeeded > 0 ? `已导入 ${succeeded} 本,${failures.length} 本失败` : failures[0]
        )
      }
    },
    [importOne, refresh]
  )

  // window.__E2E_FILES__ 只在端到端测试里存在(见 tests/e2e/helpers.ts):系统文件选择框
  // 是原生窗口,Playwright 点不到,测试改成直接把路径写进这个全局变量。这里仍然要经
  // testImportPaths() 走一趟主进程——它会把路径记入 source-gate 的白名单,效果等价于
  // 真实的 pickEpubFiles() 在拿到系统对话框结果后做的事;直接用注入的路径调用
  // importPaths 会在 stageImport 里被 assertAllowed() 拒绝。
  const onPickFiles = useCallback(async () => {
    const injected = (window as unknown as { __E2E_FILES__?: string[] }).__E2E_FILES__
    const paths = injected
      ? await window.api.testImportPaths(injected)
      : await window.api.pickEpubFiles()
    await importPaths(paths, window.api.stageImport)
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
      await importPaths(found, window.api.stageImport)
    } catch (err) {
      setError(err instanceof Error ? err.message : '扫描失败')
    } finally {
      setBusy(null)
    }
  }, [importPaths])

  // 点书卡片本身的删除按钮只是打开确认框,真正的删除动作在 confirmDelete 里。
  // stopPropagation 避免点删除按钮时顺带触发外层 book-card 的 onClick 把书打开。
  const requestDelete = useCallback((e: React.MouseEvent, book: BookRecord) => {
    e.stopPropagation()
    setError(null)
    setPendingDelete(book)
  }, [])

  const cancelDelete = useCallback(() => setPendingDelete(null), [])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await window.api.deleteBook(pendingDelete.id)
      setPendingDelete(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }, [pendingDelete, refresh])

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
      // 拖拽来的路径合法地来自渲染层本身,过不了 stageImport 背后那道
      // 只认主进程自己发出路径的闸门,要走专门给拖拽开的 stageDroppedFiles。
      await importPaths(paths, window.api.stageDroppedFiles)
    },
    [importPaths]
  )

  return (
    <main
      className={`library${dragging ? ' dropzone--active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-testid="library"
    >
      <header className="library__bar">
        <div className="brand">
          <img className="brand__icon" src={appIcon} alt="" />
          <div>
            <div className="brand__name">墨问</div>
            <div className="brand__tagline">读有所思，问有所答</div>
          </div>
        </div>
        <nav className="library__nav" aria-label="书架操作">
          <button type="button" className="button--ghost" data-testid="open-conversations" onClick={onOpenConversations}>
            对话
          </button>
          <button type="button" className="button--ghost" data-testid="open-settings" onClick={onOpenSettings}>
            设置
          </button>
          <button type="button" className="button--secondary" onClick={onPickFolder} data-testid="pick-folder">
            扫描文件夹
          </button>
          <button type="button" className="button--primary" onClick={onPickFiles} data-testid="pick-files">
            ＋ 添加 EPUB
          </button>
        </nav>
      </header>

      <section className="library__intro">
        <div>
          <p className="eyebrow">个人书库</p>
          <h1>你的书架</h1>
          <p>沉浸阅读，在需要时让 AI 帮你理解、翻译和梳理。</p>
        </div>
        <span className="library__count">{books.length} 本书</span>
      </section>

      {(busy || error) && (
        <div className={`library__notice${error ? ' library__notice--error' : ''}`} role="status">
          {error ?? `${busy}…`}
        </div>
      )}

      {books.length === 0 ? (
        <div className="empty">
          <span className="empty__icon">＋</span>
          <strong>书架是空的</strong>
          <p>把第一本书拖进来，或点击右上角的「添加 EPUB」。</p>
        </div>
      ) : (
        <div className="library__grid">
          {books.map((book) => (
            <div
              key={book.id}
              className="book-card"
              data-testid="book-card"
            >
              <button
                type="button"
                className="book-card__delete"
                data-testid="delete-book"
                aria-label={`删除《${book.title}》`}
                onClick={(e) => requestDelete(e, book)}
              >
                删除
              </button>
              <button type="button" className="book-card__open" aria-label={`打开《${book.title}》`} onClick={() => onOpenBook(book)}>
                <div className="book-card__cover">
                  {coverUrls[book.id] ? (
                    <img src={coverUrls[book.id]} alt="" />
                  ) : book.title}
                </div>
                <div className="book-card__title">{book.title}</div>
                <div className="book-card__author">{book.author ?? '佚名'}</div>
              </button>
            </div>
          ))}
        </div>
      )}

      {pendingDelete && <ConfirmDialog
        title="删除这本书？"
        message={`确定要删除《${pendingDelete.title}》吗？这会一并删除应用保存的本地文件副本，删除后无法恢复。`}
        confirmLabel="确认删除"
        onCancel={cancelDelete}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
        testId="confirm-delete"
        confirmTestId="confirm-delete-yes"
      />}
    </main>
  )
}
