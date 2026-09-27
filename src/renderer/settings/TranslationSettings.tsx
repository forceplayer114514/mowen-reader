import { useEffect, useRef, useState } from 'react'
import type { TranslationMode, TranslationSnapshot } from '@shared/translation-types'
import ConfirmDialog from '../ConfirmDialog'

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

export default function TranslationSettings() {
  const [mode, setMode] = useState<TranslationMode>('online')
  const [consent, setConsent] = useState(false)
  const [pack, setPack] = useState<TranslationSnapshot | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remove, setRemove] = useState(false)
  const alive = useRef(false)
  const actionBusy = useRef(false)

  useEffect(() => {
    alive.current = true
    let cancelled = false, changed = false
    const off = window.api.onTranslationChanged((snapshot) => {
      changed = true
      if (!cancelled) setPack(snapshot)
    })
    void Promise.all([window.api.getSetting('translation.mode'), window.api.getSetting('translation.onlineConsent'),
      window.api.translationSnapshot()]).then(([savedMode, savedConsent, snapshot]) => {
      if (cancelled) return
      setMode(savedMode === 'offline' ? 'offline' : 'online')
      setConsent(savedConsent === 'true')
      if (!changed) setPack(snapshot)
      setReady(true)
    }).catch(() => { if (!cancelled) setError('翻译设置读取失败，请重开设置重试') })
    return () => { cancelled = true; alive.current = false; off() }
  }, [])

  async function action(operation: () => Promise<void>): Promise<void> {
    if (actionBusy.current) return
    actionBusy.current = true
    setBusy(true)
    setError(null)
    try { await operation() }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '操作失败，请重试') }
    finally { actionBusy.current = false; if (alive.current) setBusy(false) }
  }

  return <section className="settings__section" data-testid="translation-settings">
    <div className="settings__section-head">
      <div><h2>划词与句子翻译</h2><p>英语 → 简体中文 · 独立于聊天模型，无需 API 密钥。</p></div>
      <span className="status-dot status-dot--ready">免费引擎</span>
    </div>
    <div className="settings__fields">
      <label><span>翻译引擎</span>
        <select data-testid="translation-mode" value={mode} disabled={!ready || busy}
          onChange={(event) => { const next = event.target.value as TranslationMode
            void action(async () => { await window.api.setSetting('translation.mode', next); if (alive.current) setMode(next) }) }}>
          <option value="online">免费在线翻译 · MyMemory</option>
          <option value="offline">离线句子翻译 · OPUS-MT</option>
        </select>
        <small>切换立即保存。在线服务有额度限制；离线模式不会自动联网或下载。</small>
      </label>
      <label className="translation-consent-setting">
        <input type="checkbox" data-testid="translation-online-consent" checked={consent} disabled={!ready || busy}
          onChange={(event) => { const next = event.target.checked
            if (actionBusy.current) return
            const previous = consent
            setConsent(next)
            void action(async () => {
              try { await window.api.setSetting('translation.onlineConsent', String(next)) }
              catch (error) { if (alive.current) setConsent(previous); throw error }
            }) }} />
        <span>允许将选中文字发送给 MyMemory（不发送整本书、聊天记录或密钥）</span>
      </label>
    </div>
    <div className="translation-pack" data-testid="translation-pack">
      <div><strong>英语 → 简体中文离线翻译包</strong>
        <p>OPUS-MT · 可翻译整句，不是单词词库。默认不下载，安装后可断网使用。</p>
        <small>{!pack ? '正在检查…' : pack.status === 'installed'
          ? `已安装 · ${megabytes(pack.size)}` : pack.status === 'downloading'
            ? `下载中 · ${megabytes(pack.received)} / ${pack.total ? megabytes(pack.total) : '正在计算'}`
            : `未安装${pack.total || pack.size ? ` · ${megabytes(pack.total || pack.size)}` : ''}`}</small>
      </div>
      <div className="translation-pack__actions">
        {pack?.status === 'downloading'
          ? <button type="button" data-testid="translation-pack-cancel"
            onClick={() => { void window.api.cancelTranslationDownload().catch(() => {
              if (alive.current) setError('取消下载失败，请重试')
            }) }}>取消下载</button>
          : pack?.status === 'installed'
            ? <button type="button" className="button--ghost" data-testid="translation-pack-remove" disabled={busy}
              onClick={() => setRemove(true)}>删除翻译包</button>
            : <button type="button" className="button--secondary" data-testid="translation-pack-download" disabled={!ready || busy}
              onClick={() => void action(() => window.api.downloadTranslationPack())}>{pack?.status === 'error' ? '重新下载' : '下载翻译包'}</button>}
      </div>
      {pack?.status === 'downloading' && <progress aria-label="离线翻译包下载进度" value={pack.received} max={pack.total || undefined} />}
    </div>
    {mode === 'offline' && pack?.status !== 'installed' && <p className="settings__hint">当前选择离线翻译，请先下载翻译包；不会自动切换到在线服务。</p>}
    {(error || pack?.message) && <p className="chat-error" role="alert" data-testid="translation-settings-error">{error || pack?.message}</p>}
    {remove && <ConfirmDialog title="删除离线翻译包？" message="只删除下载的翻译模型，不影响书籍、翻译记录、注释或高光。离线翻译将暂时不可用。"
      confirmLabel="删除翻译包" onCancel={() => setRemove(false)} busy={busy}
      onConfirm={() => void action(async () => { await window.api.removeTranslationPack(); if (alive.current) setRemove(false) })}
      testId="translation-remove-confirm" confirmTestId="translation-remove-yes" />}
  </section>
}
