import { useCallback, useEffect, useRef, useState } from 'react'
import type { OnlineAction, OnlineSnapshot } from '@shared/types'
import { bookFormat } from '@shared/book-format'
import { extractMetadata } from '../reader/metadata'

export function useOnlineLibrary() {
  const [snapshot, setSnapshot] = useState<OnlineSnapshot>({ url: 'https://z-library.bz/', loading: false,
    canGoBack: false, error: null, blockedNavigation: null, autoImport: true, tasks: [] })
  const [processing, setProcessing] = useState(false)
  const running = useRef(false)
  useEffect(() => {
    let live = true
    let received = false
    const off = window.api.onOnlineChanged(next => { received = true; if (live) setSnapshot(next) })
    void window.api.onlineSnapshot().then(next => { if (live && !received) setSnapshot(next) })
    return () => { live = false; off() }
  }, [])
  const importDownload = useCallback(async (id: string) => {
    if (running.current) return
    running.current = true; setProcessing(true)
    let claimed = false
    try {
      const bytes = await window.api.prepareDownload(id)
      if (!bytes) return
      claimed = true
      const task = snapshot.tasks.find((item) => item.id === id)
      await window.api.finishDownload(id, await extractMetadata(bytes, bookFormat(task?.name ?? '') ?? 'epub'))
    } catch (cause) {
      if (claimed) await window.api.failDownload(id, cause instanceof Error ? cause.message : '入库失败').catch(() => {})
    } finally { running.current = false; setProcessing(false) }
  }, [snapshot.tasks])
  useEffect(() => {
    if (processing || !snapshot.autoImport) return
    const ready = snapshot.tasks.find(task => task.status === 'ready')
    if (ready) void importDownload(ready.id)
  }, [snapshot, processing, importDownload])
  return { snapshot, importDownload, processing }
}

interface Props {
  snapshot: OnlineSnapshot
  onBack: () => void
  theme: string
  onToggleTheme: () => void
  downloadsOpen: boolean
  onToggleDownloads: () => void
}

export default function OnlineLibrary({ snapshot, onBack, theme, onToggleTheme, downloadsOpen, onToggleDownloads }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => {
    const element = host.current!
    const resize = () => {
      const rect = element.getBoundingClientRect()
      void window.api.onlineBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        .catch(() => setActionError('无法打开内置网站，请尝试重新进入'))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element); resize()
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); void window.api.onlineBounds(null).catch(() => {}) }
  }, [])
  function action(value: OnlineAction, approvedOrigin?: string) {
    setActionError(null)
    void window.api.onlineAction(value, approvedOrigin).catch(cause => setActionError(`操作失败：${cause instanceof Error ? cause.message : '请稍后重试'}`))
  }
  let domain = 'z-library.bz'
  try { domain = new URL(snapshot.url).hostname } catch { /* Initial page may be blank. */ }
  return <section className="online" data-testid="online-library">
    <header className="online__header">
      <button onClick={onBack}>← 书架</button>
      <div><span className="eyebrow">墨问 · 在线书库</span><h1>寻找下一本好书</h1></div>
      <button className="button--ghost" onClick={onToggleTheme}>{theme === 'dark' ? '日间模式' : '夜间模式'}</button>
    </header>
    <nav className="online__toolbar" aria-label="网站导航">
      <button aria-label="网站后退" disabled={!snapshot.canGoBack} onClick={() => action('back')}>←</button>
      <button onClick={() => action('refresh')}>刷新</button>
      <button onClick={() => action('home')}>网站首页</button>
      <span className="online__address">{snapshot.loading ? '连接中 · ' : '网站 · '}{domain}</span>
      <button data-testid="open-downloads" aria-expanded={downloadsOpen} onClick={onToggleDownloads}>下载记录{snapshot.tasks.length > 0 ? ` (${snapshot.tasks.length})` : ''}</button>
      <button className="button--secondary" onClick={() => action('external')}>用浏览器打开 ↗</button>
    </nav>
    {snapshot.blockedNavigation && <div className="online__blocked" role="status" data-testid="blocked-navigation">
      <div><strong>已拦截{snapshot.blockedNavigation.reason === 'popup' ? '网站弹窗' : '站外跳转'}</strong>
        <span>目标：{snapshot.blockedNavigation.origin}。购物广告无需放行；仅在确认是登录或下载所需站点时允许。</span></div>
      <button onClick={() => action('dismiss-navigation')}>留在当前页面</button>
      <button className="button--ghost" onClick={() => action('allow-site', snapshot.blockedNavigation!.origin)}>允许并打开（本次）</button>
    </div>}
    {(snapshot.error || actionError) && <div className="online__error" role="alert">{snapshot.error || actionError}</div>}
    <div className="online__site" ref={host} data-testid="online-site" />
    <div className="online__hint">在网站自行搜索、登录并选择 EPUB、PDF 或 TXT 下载。网站保留原有外观；仅下载你有权使用的书籍。</div>
  </section>
}

export function DownloadTray({ snapshot, importDownload, processing, onBack, onClose }: {
  snapshot: OnlineSnapshot; importDownload: (id: string) => Promise<void>; processing: boolean; onBack: () => void; onClose: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [autoImport, setAutoImport] = useState(snapshot.autoImport)
  useEffect(() => setAutoImport(snapshot.autoImport), [snapshot.autoImport])
  const labels = { downloading: '下载中', validating: '校验中', ready: '待入库', importing: '入库中', imported: '已入库', error: '未完成', cancelled: '已取消' }
  return <aside className="downloads" data-testid="download-tray" aria-label="下载任务">
    <div className="downloads__heading"><strong>下载与入库</strong><span>EPUB / PDF / TXT · 自动加入默认书库</span>
      <label><input type="checkbox" checked={autoImport} onChange={e => {
        setAutoImport(e.target.checked)
        void window.api.onlineAutoImport(e.target.checked).catch(() => { setAutoImport(snapshot.autoImport); setError('设置失败') })
      }} /> 下载后自动入库</label>
      <button className="button--ghost downloads__close" aria-label="关闭下载面板" title="收起面板，不会取消下载" onClick={onClose}>×</button></div>
    {error && <p role="alert">{error}</p>}
    <div className="downloads__list">
      {snapshot.tasks.length === 0 && <span className="downloads__empty">还没有下载任务。点击网站里的下载按钮即可开始。</span>}
      {snapshot.tasks.map(task => <div className="downloads__task" key={task.id} data-testid="download-task">
        <div className="downloads__info"><strong title={task.name}>{task.name}</strong><span>{task.message || labels[task.status]}
          {task.status === 'downloading' && ` · ${(task.received / 1048576).toFixed(1)}${task.total > 0 ? ` / ${(task.total / 1048576).toFixed(1)}` : ''} MB`}</span>
          {task.status === 'downloading' && <progress max={task.total || undefined} value={task.total ? task.received : undefined} aria-label="下载进度" />}</div>
        <span className={`downloads__status downloads__status--${task.status}`}>{labels[task.status]}</span>
        {task.canImport && ['ready', 'error'].includes(task.status) && <button disabled={processing} onClick={() => void importDownload(task.id)}>{task.status === 'error' ? '重试入库' : '导入'}</button>}
        {task.status === 'imported' && <button onClick={onBack}>查看书架</button>}
        {!['importing', 'validating'].includes(task.status) && <button className="button--ghost" aria-label={`${task.status === 'downloading' ? '取消' : '移除'} ${task.name}`} onClick={() => {
          setError(null); void window.api.removeDownload(task.id).catch(() => setError('暂时无法移除任务'))
        }}>{task.status === 'downloading' ? '取消' : '移除'}</button>}
      </div>)}
    </div>
  </aside>
}
