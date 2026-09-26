import './styles/theme.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

/**
 * 冷启动时先按存储的主题设置好 document 根元素的 data-theme,再渲染整个应用。
 *
 * 在这之前,data-theme 只在 ReaderView 打开一本书时才会被设置一次——书架本身
 * 从不读这个设置,所以冷启动直接看书架时,不管上次存的是深色还是浅色,书架
 * 永远先按 CSS 里没有 data-theme 属性时的默认(浅色)渲染,要等用户点开一本书,
 * ReaderView 的 boot() 才会顺带把这个全局属性纠正过来。这里把同样的读取动作
 * 提到应用入口、渲染之前执行,让它覆盖书架和阅读界面两个场景,而不是只藏在
 * 阅读界面一个视图里。
 */
async function applyStoredTheme(): Promise<void> {
  let theme = 'light'
  try {
    theme = (await window.api.getSetting('theme')) === 'dark' ? 'dark' : 'light'
  } catch {
    // 读取失败就用默认的浅色主题,不能因为这个阻塞应用启动。
  }
  document.documentElement.dataset.theme = theme
}

void applyStoredTheme().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
