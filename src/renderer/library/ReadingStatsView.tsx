import { useCallback, useEffect, useState } from 'react'
import type { BookRecord } from '@shared/types'
import { formatReadingTime, localDay, readingPercent, type ReadingStats } from '@shared/reading-stats'
import { useBookCovers } from './useBookCovers'
import type { ThemeName } from '../reader/types'

interface Props {
  onBack: () => void
  onOpenBook: (book: BookRecord) => void
  theme: ThemeName
  onToggleTheme: () => void
}

const EMPTY_BOOKS: BookRecord[] = []

export default function ReadingStatsView({ onBack, onOpenBook, theme, onToggleTheme }: Props) {
  const [data, setData] = useState<{ stats: ReadingStats; books: BookRecord[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<7 | 30>(7)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [goalMinutes, setGoalMinutes] = useState(0)
  const covers = useBookCovers(data?.books ?? EMPTY_BOOKS)
  const load = useCallback(async () => {
    try {
      const [stats, books] = await Promise.all([window.api.readingStats(), window.api.listBooks()])
      setData({ stats, books })
      setNow(new Date())
      setError(null)
    } catch { setError('统计暂时无法读取，已保存的阅读记录未删除，请重试。') }
  }, [])
  useEffect(() => {
    void load()
    void window.api.getSetting('readingGoalMinutes').then(value => setGoalMinutes(['10', '20', '30', '60'].includes(value ?? '') ? Number(value) : 0)).catch(() => {})
    const interval = setInterval(() => void load(), 60_000)
    return () => clearInterval(interval)
  }, [load])

  const today = localDay(now)
  const dayTotals = new Map(data?.stats.days.map(day => [day.day, day.milliseconds]))
  const todayMilliseconds = dayTotals.get(today) ?? 0
  const goalPercent = goalMinutes ? Math.min(100, Math.floor(todayMilliseconds / (goalMinutes * 60_000) * 100)) : 0
  const days = Array.from({ length: range }, (_, i) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - range + i + 1)
    const day = localDay(date)
    return { day, label: `${date.getMonth() + 1}/${date.getDate()}`, milliseconds: dayTotals.get(day) ?? 0 }
  })
  const recent = days.slice(-7).reduce((sum, day) => sum + day.milliseconds, 0)
  const total = data?.stats.days.reduce((sum, day) => sum + day.milliseconds, 0) ?? 0
  const maximum = Math.max(60_000, ...days.map(day => day.milliseconds))
  const chartDay = days.find(day => day.day === selectedDay) ?? days[days.length - 1]
  const byBook = new Map(data?.stats.books.map(book => [book.bookId, book]))
  const sortedBooks = [...(data?.books ?? [])].sort((a, b) => (byBook.get(b.id)?.milliseconds ?? 0) - (byBook.get(a.id)?.milliseconds ?? 0))
  const completedBooks = (data?.books ?? []).filter(book => (book.readProgress ?? 0) >= 1)
  const averageProgress = data?.books.length
    ? readingPercent(data.books.reduce((sum, book) => sum + (book.readProgress ?? 0), 0) / data.books.length)
    : 0

  return <main className="reading-stats" data-testid="reading-stats">
    <header className="reading-stats__header">
      <button type="button" className="button--ghost" onClick={onBack}>← 返回书架</button>
      <span className="reading-stats__header-label">墨问 · 阅读足迹</span>
      <button type="button" className="button--ghost" data-testid="toggle-theme" onClick={onToggleTheme}>
        {theme === 'light' ? '夜间模式' : '日间模式'}
      </button>
    </header>
    <section className="reading-stats__intro">
      <p className="eyebrow">READING MOMENTS</p>
      <h1>把时间，留给好书。</h1>
      <p>每一次翻开，都在慢慢积累。</p>
    </section>
    {error && <div className="reading-stats__error" role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></div>}
    {!data ? <div className="empty" role="status">{error ? '等待重新读取统计' : '正在整理阅读足迹…'}</div> : <>
      <section className="reading-stats__summary" aria-label="阅读概览">
        <div className="reading-stats__today">
          <span className="reading-stats__today-icon" aria-hidden="true">◷</span>
          <p>今日阅读</p>
          <strong data-testid="stats-today">{formatReadingTime(dayTotals.get(today) ?? 0)}</strong>
          <span>{(dayTotals.get(today) ?? 0) > 0 ? '今天，也为自己留了一点阅读时间。' : '从一页开始，今天的故事还在等你。'}</span>
          <div className="reading-stats__goal">
            <label>每日目标 <select data-testid="reading-goal" value={goalMinutes} onChange={event => {
              const next = Number(event.target.value)
              void window.api.setSetting('readingGoalMinutes', String(next)).then(() => setGoalMinutes(next)).catch(() => setError('阅读目标保存失败，请重试。'))
            }}><option value={0}>不设置</option><option value={10}>10 分钟</option><option value={20}>20 分钟</option><option value={30}>30 分钟</option><option value={60}>60 分钟</option></select></label>
            {goalMinutes > 0 && <><span data-testid="reading-goal-progress">{goalPercent >= 100 ? '今日已达成' : `已完成 ${goalPercent}%`}</span>
              <span className="reading-stats__goal-track" role="progressbar" aria-label="今日阅读目标" aria-valuenow={goalPercent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${goalPercent}%` }} /></span></>}
          </div>
        </div>
        <div className="reading-stats__metric"><span>近 7 天</span><strong data-testid="stats-week">{formatReadingTime(recent)}</strong><small>一点一滴，都是收获</small></div>
        <div className="reading-stats__metric"><span>累计阅读</span><strong data-testid="stats-total">{formatReadingTime(total)}</strong><small>属于你的安静时光</small></div>
        <div className="reading-stats__metric"><span>阅读日</span><strong>{data.stats.days.length}<em> 天</em></strong><small>读过 {data.books.filter(book => book.lastReadAt !== null || (book.readProgress ?? 0) > 0).length} 本书</small></div>
        <div className="reading-stats__metric"><span>书库进度</span><strong data-testid="stats-progress">{averageProgress}<em>%</em></strong><small>书库所有书籍的平均进度</small></div>
        <div className="reading-stats__metric"><span>已读完</span><strong data-testid="stats-completed">{completedBooks.length}<em> 本</em></strong><small>已到达末页的书籍</small></div>
      </section>

      <section className="reading-stats__panel" aria-labelledby="stats-trend-title">
        <div className="reading-stats__panel-heading">
          <div><h2 id="stats-trend-title">阅读的节奏</h2><p>不必每天一样多，慢慢读就很好。</p></div>
          <div className="reading-stats__range" aria-label="统计时间范围">
            {([7, 30] as const).map(value => <button key={value} type="button" aria-pressed={range === value}
              onClick={() => { setRange(value); setSelectedDay(null) }}>近 {value} 天</button>)}
          </div>
        </div>
        <div className="reading-stats__chart-detail" aria-live="polite"><span>{chartDay.day === today ? '今天' : chartDay.label}</span><strong>{formatReadingTime(chartDay.milliseconds)}</strong></div>
        <div className="reading-stats__chart" data-testid="stats-chart" style={{ '--columns': range } as React.CSSProperties}>
          <span className="reading-stats__chart-scale">最高 {formatReadingTime(maximum)}</span>
          {days.map((day, index) => <div className="reading-stats__chart-column" key={day.day}>
            <button type="button" className={`reading-stats__bar${day.day === chartDay.day ? ' reading-stats__bar--selected' : ''}`}
              aria-label={`${day.day}，阅读${formatReadingTime(day.milliseconds)}`} aria-pressed={day.day === chartDay.day}
              title={`${day.day} · ${formatReadingTime(day.milliseconds)}`}
              onClick={() => setSelectedDay(day.day)} onFocus={() => setSelectedDay(day.day)} onMouseEnter={() => setSelectedDay(day.day)}>
              <span style={{ height: day.milliseconds ? `${Math.max(2, day.milliseconds / maximum * 100)}%` : '3px' }} />
            </button>
            <span className="reading-stats__chart-date">{range === 7 || index % 5 === 0 || index === range - 1 ? day.day === today ? '今天' : day.label : ''}</span>
          </div>)}
        </div>
      </section>

      <section className="reading-stats__panel" aria-labelledby="stats-books-title">
        <div className="reading-stats__panel-heading"><div><h2 id="stats-books-title">时间都去了哪本书</h2><p>按累计阅读时长排列，点击书本继续阅读。</p></div><span className="reading-stats__book-count">{sortedBooks.length} 本书</span></div>
        {sortedBooks.length === 0 ? <div className="reading-stats__empty">还没有书籍。回到书架，添加你的第一本书吧。</div> :
          <div className="reading-stats__books">{sortedBooks.map((book, index) => {
            const record = byBook.get(book.id)
            const milliseconds = record?.milliseconds ?? 0
            return <button type="button" className="reading-stats__book" data-testid="stats-book" key={book.id}
              aria-label={`继续阅读《${book.title}》`} onClick={() => onOpenBook(book)}>
              <span className="reading-stats__rank">{String(index + 1).padStart(2, '0')}</span>
              <span className="reading-stats__cover">{covers[book.id] ? <img src={covers[book.id]} alt="" /> : <span aria-hidden="true">文</span>}</span>
              <span className="reading-stats__book-info"><strong>{book.title}</strong><small>{book.author ?? '佚名'}{record ? ` · 阅读 ${record.days} 天` : book.lastReadAt !== null || (book.readProgress ?? 0) > 0 ? ' · 暂无时长记录' : ' · 尚未开始'}</small>
                <span className="reading-stats__book-progress"><span>{readingPercent(book.readProgress) === 100 ? '已读完' : '已读'}</span><strong data-testid="stats-book-progress">{readingPercent(book.readProgress)}%</strong></span>
                <span className="reading-stats__book-meter" role="progressbar" aria-label={`《${book.title}》阅读进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={readingPercent(book.readProgress)}><span style={{ width: `${readingPercent(book.readProgress)}%` }} /></span>
              </span>
              <span className="reading-stats__book-time"><strong>{formatReadingTime(milliseconds)}</strong><small>{record ? `最近 ${record.lastDay.replaceAll('-', '.')}` : book.lastReadAt !== null ? '继续阅读' : '翻开第一章'}</small></span>
              <span className="reading-stats__book-arrow" aria-hidden="true">↗</span>
            </button>
          })}</div>}
      </section>
      <p className="reading-stats__note">从本版开始记录 · 仅计入阅读页在前台且未闲置的时间 · 每 15 秒保存到本地<br />切换软件、最小化、锁屏或连续 5 分钟无操作会暂停；删除书籍会一并删除该书统计。</p>
    </>}
  </main>
}
