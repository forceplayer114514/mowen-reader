import { useState } from 'react'
import type { BookRecord } from '@shared/types'
import LibraryView from './library/LibraryView'
import ConversationsView from './library/ConversationsView'
import ReaderView from './reader/ReaderView'
import SettingsView from './settings/SettingsView'
import type { ThemeName } from './reader/types'

export default function App() {
  const [reading, setReading] = useState<BookRecord | null>(null)
  const [page, setPage] = useState<'library' | 'settings' | 'conversations'>('library')
  const [theme, setTheme] = useState<ThemeName>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  )
  const [themeError, setThemeError] = useState<string | null>(null)

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

  const view = reading ? <ReaderView book={reading} onBack={() => setReading(null)} theme={theme} onToggleTheme={toggleTheme} />
    : page === 'settings' ? <SettingsView onBack={() => setPage('library')} />
    : page === 'conversations' ? <ConversationsView onBack={() => setPage('library')} />
    : (
    <LibraryView
      onOpenBook={setReading}
      onOpenSettings={() => setPage('settings')}
      onOpenConversations={() => setPage('conversations')}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  )
  return <>{view}{themeError && <div className="app__notice" role="alert">{themeError}</div>}</>
}
