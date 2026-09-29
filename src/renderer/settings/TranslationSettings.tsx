import { useEffect, useRef, useState } from 'react'
import type { TranslationMode, TranslationSnapshot } from '@shared/translation-types'
import ConfirmDialog from '../ConfirmDialog'

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

export default function TranslationSettings() {
  const [mode, setMode] = useState<TranslationMode>('online')
  const [consent, setConsent] = useState(false)
  const [pack, setPack] = useState<TranslationSnapshot | null>(null)
  const [dictionary, setDictionary] = useState<TranslationSnapshot | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remove, setRemove] = useState(false)
  const [removeDictionary, setRemoveDictionary] = useState(false)
  const alive = useRef(false)
  const actionBusy = useRef(false)

  useEffect(() => {
    alive.current = true
    let cancelled = false, changed = false, dictionaryChanged = false
    const off = window.api.onTranslationChanged((snapshot) => {
      changed = true
      if (!cancelled) setPack(snapshot)
    })
    const offDictionary = window.api.onDictionaryChanged((snapshot) => {
      dictionaryChanged = true
      if (!cancelled) setDictionary(snapshot)
    })
    void Promise.all([window.api.getSetting('translation.mode'), window.api.getSetting('translation.onlineConsent'),
      window.api.translationSnapshot(), window.api.dictionarySnapshot()]).then(([savedMode, savedConsent, snapshot, wordSnapshot]) => {
      if (cancelled) return
      setMode(savedMode === 'offline' ? 'offline' : 'online')
      setConsent(savedConsent === 'true')
      if (!changed) setPack(snapshot)
      if (!dictionaryChanged) setDictionary(wordSnapshot)
      setReady(true)
    }).catch(() => { if (!cancelled) setError('翻译设置读取失败，请重开设置重试') })
    return () => { cancelled = true; alive.current = false; off(); offDictionary() }
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
    <p className="settings__hint">两种离线资源各管一件事，可分别下载或删除：只想离线查单词，装词典即可；还想离线翻译整句或段落，再装翻译包。已有翻译记录不会受影响。</p>
    <div className="settings__fields">
      <label><span>翻译引擎</span>
        <select data-testid="translation-mode" value={mode} disabled={!ready || busy}
          onChange={(event) => { const next = event.target.value as TranslationMode
            void action(async () => { await window.api.setSetting('translation.mode', next); if (alive.current) setMode(next) }) }}>
          <option value="online">在线 · 有道词典查词 / MyMemory 译句</option>
          <option value="offline">离线 · ECDICT 查词 / OPUS-MT 译句</option>
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
        <span>允许将所选单词发送给有道词典、所选句子发送给 MyMemory（不发送整本书、聊天记录或密钥）</span>
      </label>
    </div>
    <div className="translation-pack" data-testid="dictionary-pack">
      <div><strong>离线词典 · 查单词</strong>
        <p>ECDICT · 显示单词音标和多条释义，喇叭朗读原词；不负责整句翻译。默认不下载。</p>
        <small>{!dictionary ? '正在检查…' : dictionary.status === 'installed' ? '已安装'
          : dictionary.status === 'downloading' ? `下载与整理中 · ${megabytes(dictionary.received)} / ${megabytes(dictionary.total)}`
            : `未安装 · 原始词库 ${megabytes(dictionary.total)}`}</small>
      </div>
      <div className="translation-pack__actions">
        {dictionary?.status === 'downloading'
          ? <button type="button" data-testid="dictionary-cancel" onClick={() => void window.api.cancelDictionaryDownload()}>取消下载</button>
          : dictionary?.status === 'installed'
            ? <button type="button" className="button--ghost" data-testid="dictionary-remove" disabled={busy} onClick={() => setRemoveDictionary(true)}>删除词典</button>
            : <button type="button" className="button--secondary" data-testid="dictionary-download" disabled={!ready || busy}
              onClick={() => void action(() => window.api.downloadDictionary())}>{dictionary?.status === 'error' ? '重新下载词典' : '下载词典'}</button>}
      </div>
      {dictionary?.status === 'downloading' && <progress aria-label="离线词典下载进度" value={dictionary.received} max={dictionary.total} />}
    </div>
    <div className="translation-pack" data-testid="translation-pack">
      <div><strong>离线翻译包 · 译整句</strong>
        <p>OPUS-MT · 翻译句子和段落；不提供单词音标或多义项。默认不下载。</p>
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
    {mode === 'offline' && (pack?.status !== 'installed' || dictionary?.status !== 'installed') && <p className="settings__hint">离线模式只在使用缺少的那项功能时提示下载，不会自动联网或要求两个包一起安装。</p>}
    {(error || pack?.message || dictionary?.message) && <p className="chat-error" role="alert" data-testid="translation-settings-error">{error || pack?.message || dictionary?.message}</p>}
    {removeDictionary && <ConfirmDialog title="删除离线词典？" message="删除后无法离线查单词；已安装的整句翻译包和已有翻译记录不受影响。"
      confirmLabel="删除词典" onCancel={() => setRemoveDictionary(false)} busy={busy}
      onConfirm={() => void action(async () => { await window.api.removeDictionary(); if (alive.current) setRemoveDictionary(false) })}
      testId="dictionary-remove-confirm" confirmTestId="dictionary-remove-yes" />}
    {remove && <ConfirmDialog title="删除离线翻译包？" message="删除后无法离线翻译整句；已安装的单词词典和已有翻译记录不受影响。"
      confirmLabel="删除翻译包" onCancel={() => setRemove(false)} busy={busy}
      onConfirm={() => void action(async () => { await window.api.removeTranslationPack(); if (alive.current) setRemove(false) })}
      testId="translation-remove-confirm" confirmTestId="translation-remove-yes" />}
  </section>
}
