import { useState } from 'react'
import type { BookRecord } from '@shared/types'
import LibraryView from './library/LibraryView'
import ConversationsView from './library/ConversationsView'
import ReaderView from './reader/ReaderView'
import SettingsView from './settings/SettingsView'
import type { ThemeName } from './reader/types'
import OnlineLibrary, { DownloadTray, useOnlineLibrary } from './library/OnlineLibrary'

export default function App() {
  const [reading, setReading] = useState<BookRecord | null>(null)
  const [page, setPage] = useState<'library' | 'settings' | 'conversations' | 'online'>('library')
  const online = useOnlineLibrary()
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const libraryRevision = online.snapshot.tasks.filter(task => task.status === 'imported').map(task => task.bookId).join(',')
  const showDownloads = !reading && downloadsOpen && (page === 'online' || page === 'library')
  const [theme, setTheme] = useState<ThemeName>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  )
  const [themeError, setThemeError] = useState<string | null>(null)

  function backToLibrary(): void { setReading(null); setDownloadsOpen(false); setPage('library') }

  function toggleTheme(): void {
    const next: ThemeName = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    setTheme(next)
    setThemeError(null)
    // 副作用放在事件中，不能放进 StrictMode 会重复调用的 state updater。
    void window.api.setSetting('theme', next).catch(() => {
      setThemeError('主题没有保存，下次打开可能会恢复原设置')
    })
  }

  const view = reading ? <ReaderView book={reading} onBack={backToLibrary} theme={theme} onToggleTheme={toggleTheme} />
    : page === 'settings' ? <SettingsView onBack={backToLibrary} />
    : page === 'conversations' ? <ConversationsView onBack={backToLibrary} />
    : page === 'online' ? <OnlineLibrary snapshot={online.snapshot} onBack={backToLibrary} theme={theme} onToggleTheme={toggleTheme}
      downloadsOpen={downloadsOpen} onToggleDownloads={() => setDownloadsOpen(!downloadsOpen)} />
    : (
    <LibraryView
      onOpenBook={setReading}
      onOpenSettings={() => setPage('settings')}
      onOpenConversations={() => setPage('conversations')}
      onOpenOnline={() => { setDownloadsOpen(true); setPage('online') }}
      onOpenDownloads={() => setDownloadsOpen(!downloadsOpen)}
      downloadCount={online.snapshot.tasks.length}
      downloadsOpen={downloadsOpen}
      revision={libraryRevision}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  )
  return <div className={`app${showDownloads ? ' app--downloads' : ''}`}><div className="app__view">{view}</div>
    {showDownloads && <DownloadTray {...online} onBack={backToLibrary} onClose={() => setDownloadsOpen(false)} />}
    {themeError && <div className="app__notice" role="alert">{themeError}</div>}</div>
}
