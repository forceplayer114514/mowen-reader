import { useCallback, useEffect, useState } from 'react'
import type { BookRecord, ImportedFile } from '@shared/types'
import { bookFormat } from '@shared/book-format'
import { readingPercent } from '@shared/reading-stats'
import { extractMetadata } from '../reader/metadata'
import appIcon from '../assets/mowen-icon.png'
import ConfirmDialog from '../ConfirmDialog'
import { useBookCovers } from './useBookCovers'
import type { ThemeName } from '../reader/types'

interface Props {
  onOpenBook: (book: BookRecord) => void
  onOpenSettings?: () => void
  onOpenConversations?: () => void
  onOpenExcerpts?: () => void
  onOpenStats?: () => void
  onOpenOnline?: () => void
  onOpenDownloads?: () => void
  downloadCount?: number
  downloadsOpen?: boolean
  revision?: string
  theme: ThemeName
  onToggleTheme: () => void
}

type Stager = (sourcePaths: string[]) => Promise<ImportedFile[]>

export default function LibraryView({ onOpenBook, onOpenSettings, onOpenConversations, onOpenExcerpts, onOpenStats, onOpenOnline, onOpenDownloads, downloadCount, downloadsOpen, revision, theme, onToggleTheme }: Props) {
  const [books, setBooks] = useState<BookRecord[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'unread' | 'reading' | 'finished'>('all')
  const [sort, setSort] = useState<'recent' | 'title' | 'added'>('recent')
  const coverUrls = useBookCovers(books)
  const search = query.trim().normalize('NFKC').toLowerCase()
  const filteredBooks = books.filter(book => {
    if (!`${book.title} ${book.author ?? ''}`.normalize('NFKC').toLowerCase().includes(search)) return false
    if (status === 'finished') return (book.readProgress ?? 0) >= 1
    if (status === 'reading') return (book.readProgress ?? 0) > 0 && (book.readProgress ?? 0) < 1 || book.lastReadAt !== null && (book.readProgress ?? 0) === 0
    if (status === 'unread') return book.lastReadAt === null && (book.readProgress ?? 0) === 0
    return true
  }).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-Hans-CN')
    : sort === 'added' ? b.addedAt - a.addedAt : (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0) || b.addedAt - a.addedAt)
  // listBooks 已按最近阅读时间倒序；搜索只筛选书卡，不改变继续阅读的目标。
  const lastBook = books.find(book => book.lastReadAt !== null)
  // 等待用户确认删除的那本书;非 null 时弹出确认框。删除会连带清掉用户复制
  // 进库的文件副本,不可撤销,所以必须先经过这一步确认,不能点了就删。
  const [pendingDelete, setPendingDelete] = useState<BookRecord | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingTranslationId, setTogglingTranslationId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setBooks(await window.api.listBooks())
      setError((old) => old === '书库读取失败，已保存的书籍未删除，请重试' ? null : old)
    } catch {
      setError('书库读取失败，已保存的书籍未删除，请重试')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, revision])

  // 每本书独立完成"复制进库 -> 读元数据 -> 落库"这一整套动作,失败了
  // 只清理这一本自己复制出来的文件,不影响其它书——这样一批里有几本
  // 坏文件,不会连累前面已经导入成功的书变成孤儿文件,也不会让它们
  // 因为后面抛错而白导入一遍却不落库。
  const importOne = useCallback(
    async (sourcePath: string, stage: Stager): Promise<string | null> => {
      let staged: ImportedFile | null = null
      try {
        if ((await window.api.listBooks()).some(book => book.sourcePath === sourcePath)) return '书架里已有来自同一路径的书籍'
        const [file] = await stage([sourcePath])
        staged = file
        const bytes = await window.api.readStagedFile(file.id)
        const meta = await extractMetadata(bytes, bookFormat(file.filePath) ?? 'epub')
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
          if (failure) failures.push(`${paths[i].split(/[\\/]/).pop() ?? '未知文件'}：${failure}`)
          else succeeded++
        }
      } finally {
        setBusy(null)
        // 不管是全部成功、部分失败还是全部失败,已经落库的书都要露出来。
        await refresh()
      }
      if (failures.length > 0) {
        setError(`${succeeded > 0 ? `已导入 ${succeeded} 本；` : ''}${failures.length} 本未导入：${failures.slice(0, 3).join('；')}${failures.length > 3 ? `；另有 ${failures.length - 3} 本` : ''}`)
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
        setError('这个文件夹里没有发现未导入的 EPUB、PDF 或 TXT')
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

  // AI 整书翻译按书独立手动开启，默认关闭；开关只影响阅读页入口，已缓存译文保留不删。
  const toggleTranslation = useCallback(async (e: React.MouseEvent, book: BookRecord) => {
    e.stopPropagation()
    if (togglingTranslationId) return
    setTogglingTranslationId(book.id)
    setError(null)
    try {
      const enabled = await window.api.setBookTranslationEnabled(book.id, !book.translationEnabled)
      setBooks((items) => items.map((item) => item.id === book.id ? { ...item, translationEnabled: enabled } : item))
    } catch (err) {
      setError(err instanceof Error ? err.message : '翻译开关保存失败')
    } finally {
      setTogglingTranslationId(null)
    }
  }, [togglingTranslationId])

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
        if (path && bookFormat(path)) paths.push(path)
      }
      if (paths.length === 0) {
        setError('拖进来的文件里没有 EPUB、PDF 或 TXT')
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
          <button type="button" className="button--ghost" data-testid="toggle-theme" onClick={onToggleTheme}>
            {theme === 'light' ? '夜间模式' : '日间模式'}
          </button>
          <button type="button" className="button--ghost" data-testid="open-conversations" onClick={onOpenConversations}>
            对话
          </button>
          <button type="button" className="button--ghost" data-testid="open-excerpts" onClick={onOpenExcerpts}>
            摘录
          </button>
          <button type="button" className="button--ghost" data-testid="open-stats" onClick={onOpenStats}>统计</button>
          <button type="button" className="button--ghost" data-testid="open-settings" onClick={onOpenSettings}>
            设置
          </button>
          <button type="button" className="button--secondary" onClick={onPickFolder} data-testid="pick-folder">
            扫描文件夹
          </button>
          <button type="button" className="button--secondary" data-testid="download-books"
            title="在墨问内打开在线书库" onClick={onOpenOnline}>
            下载电子书
          </button>
          {!!downloadCount && <button type="button" className="button--ghost" data-testid="open-downloads"
            aria-expanded={downloadsOpen} onClick={onOpenDownloads}>下载记录 ({downloadCount})</button>}
          <button type="button" className="button--primary" onClick={onPickFiles} data-testid="pick-files">
            ＋ 添加书籍
          </button>
        </nav>
      </header>

      <section className="library__intro">
        <div>
          <p className="eyebrow">个人书库</p>
          <h1>你的书架</h1>
          <p>支持 EPUB、PDF、TXT。在需要时让 AI 帮你理解、翻译和梳理。</p>
        </div>
        <span className="library__count" data-testid="library-count">{search || status !== 'all' ? `${filteredBooks.length} / ${books.length}` : books.length} 本书</span>
      </section>

      <div className="library__tools">
        <div className="library__search">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" />
          </svg>
          <input type="search" data-testid="library-search" aria-label="搜索图书" placeholder="搜索书名或作者…"
            value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery('') }} />
          {query && <button type="button" className="button--icon" aria-label="清空搜索" onClick={() => setQuery('')}>×</button>}
        </div>
        <label className="library__select">状态 <select data-testid="library-status" value={status} onChange={event => setStatus(event.target.value as typeof status)}>
          <option value="all">全部</option><option value="unread">未开始</option><option value="reading">阅读中</option><option value="finished">已读完</option>
        </select></label>
        <label className="library__select">排序 <select data-testid="library-sort" value={sort} onChange={event => setSort(event.target.value as typeof sort)}>
          <option value="recent">最近阅读</option><option value="added">最近添加</option><option value="title">书名</option>
        </select></label>
        <button type="button" className="button--primary library__continue" data-testid="continue-reading"
          disabled={!lastBook || error === '书库读取失败，已保存的书籍未删除，请重试'}
          title={lastBook ? `继续阅读（${lastBook.title}）` : '打开一本书后，可从这里接着读'}
          onClick={() => { if (lastBook) onOpenBook(lastBook) }}>
          <span aria-hidden="true">↗</span><span>{lastBook ? `继续阅读（${lastBook.title}）` : '继续阅读'}</span>
        </button>
      </div>

      {(busy || error) && (
        <div className={`library__notice${error ? ' library__notice--error' : ''}`} role="status">
          {error ?? `${busy}…`}
          {error === '书库读取失败，已保存的书籍未删除，请重试' && (
            <button type="button" onClick={() => void refresh()}>重新读取书库</button>
          )}
        </div>
      )}

      {books.length === 0 ? (
        <div className="empty">
          <span className="empty__icon">＋</span>
          <strong>{error === '书库读取失败，已保存的书籍未删除，请重试' ? '书库暂时无法读取' : '书架是空的'}</strong>
          <p>{error === '书库读取失败，已保存的书籍未删除，请重试' ? '请先重试，不需要重新导入原有书籍。' : '把 EPUB、PDF 或 TXT 拖进来，或点击右上角的「添加书籍」。'}</p>
        </div>
      ) : filteredBooks.length === 0 ? (
        <div className="empty" role="status">
          <strong>没有找到匹配的图书</strong>
          <p>试试其他书名或作者，或清除筛选查看全部书籍。</p>
          <button type="button" className="button--secondary" onClick={() => { setQuery(''); setStatus('all') }}>查看全部书籍</button>
        </div>
      ) : (
        <div className="library__grid">
          {filteredBooks.map((book) => (
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
              <button
                type="button"
                className={`book-card__translate${book.translationEnabled ? ' book-card__translate--active' : ''}`}
                data-testid="toggle-translation"
                aria-pressed={Boolean(book.translationEnabled)}
                aria-label={`${book.translationEnabled ? '关闭' : '开启'}《${book.title}》的 AI 翻译`}
                title={book.translationEnabled ? 'AI 翻译已开启（点击关闭，仅隐藏入口，缓存保留）' : '开启本书的 AI 翻译（逐页翻译，缓存保留）'}
                disabled={togglingTranslationId === book.id}
                onClick={(e) => void toggleTranslation(e, book)}
              >
                {book.translationEnabled ? '译·开' : '译·关'}
              </button>
              <button type="button" className="book-card__open" aria-label={`打开《${book.title}》`} onClick={() => onOpenBook(book)}>
                <div className="book-card__cover">
                  {coverUrls[book.id] ? (
                    <img src={coverUrls[book.id]} alt="" />
                  ) : book.title}
                  <span className="book-card__progress" data-testid="book-progress" aria-label={`已读 ${readingPercent(book.readProgress)}%`}>{readingPercent(book.readProgress)}%</span>
                </div>
                <div className="book-card__title">{book.title}</div>
                <div className="book-card__author">{book.author ?? '佚名'} · {(bookFormat(book.filePath) ?? 'epub').toUpperCase()}</div>
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
