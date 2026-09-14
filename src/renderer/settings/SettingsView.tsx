import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_SYSTEM_PROMPT,
  SETTING_KEYS
} from './defaults'

interface Props {
  onBack: () => void
}

function readLimit(value: string | null): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : DEFAULT_CONTEXT_LIMIT
}

export default function SettingsView({ onBack }: Props) {
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKeyInput] = useState('')
  const [prompt, setPrompt] = useState(DEFAULT_SYSTEM_PROMPT)
  const [limit, setLimit] = useState(String(DEFAULT_CONTEXT_LIMIT))
  const [keyConfigured, setKeyConfigured] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const testRequest = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.getSetting(SETTING_KEYS.endpoint),
      window.api.getSetting(SETTING_KEYS.model),
      window.api.getSetting(SETTING_KEYS.systemPrompt),
      window.api.getSetting(SETTING_KEYS.contextLimit),
      window.api.hasApiKey()
    ]).then(([savedEndpoint, savedModel, savedPrompt, savedLimit, hasKey]) => {
      if (cancelled) return
      setEndpoint(savedEndpoint ?? '')
      setModel(savedModel ?? '')
      setPrompt(savedPrompt ?? DEFAULT_SYSTEM_PROMPT)
      setLimit(String(readLimit(savedLimit)))
      setKeyConfigured(hasKey)
    }).catch(() => {
      if (!cancelled) setStatus('设置读取失败，请稍后重试')
    })
    return () => {
      cancelled = true
      const requestId = testRequest.current
      if (requestId) void window.api.abortChat(requestId).catch(() => {})
    }
  }, [])

  async function save(): Promise<void> {
    const parsedLimit = Number(limit)
    if (!endpoint.trim()) {
      setStatus('请填写接口地址')
      return
    }
    if (!model.trim()) {
      setStatus('请填写模型名')
      return
    }
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      setStatus('上下文上限必须是大于 0 的数字')
      return
    }

    setBusy(true)
    setStatus(null)
    try {
      // Keep this order: the secret is encrypted with the endpoint currently in
      // the main-process settings table. A blank key intentionally leaves it alone.
      await window.api.setSetting(SETTING_KEYS.endpoint, endpoint.trim())
      if (apiKey.length > 0) {
        await window.api.setApiKey(apiKey)
        setApiKeyInput('')
      }
      await window.api.setSetting(SETTING_KEYS.model, model.trim())
      await window.api.setSetting(SETTING_KEYS.systemPrompt, prompt)
      await window.api.setSetting(SETTING_KEYS.contextLimit, String(parsedLimit))
      setKeyConfigured(await window.api.hasApiKey())
      setStatus('设置已保存')
    } catch (error) {
      setKeyConfigured(await window.api.hasApiKey().catch(() => false))
      setStatus(error instanceof Error ? error.message : '设置保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function clearKey(): Promise<void> {
    setBusy(true)
    try {
      await window.api.clearApiKey()
      setApiKeyInput('')
      setKeyConfigured(false)
      setStatus('API 密钥已清除')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '清除密钥失败')
    } finally {
      setBusy(false)
    }
  }

  async function testConnection(): Promise<void> {
    if (testRequest.current) return
    setStatus('正在测试连接…')
    let requestId: string | null = null
    let offChunk: (() => void) | null = null
    let offDone: (() => void) | null = null
    const cleanup = (): void => {
      offChunk?.()
      offDone?.()
      offChunk = null
      offDone = null
      testRequest.current = null
      setTesting(false)
    }
    try {
      setTesting(true)
      requestId = await window.api.startChat({
        messages: [{ role: 'user', content: '请只回复：连接成功。' }]
      })
      testRequest.current = requestId
      const done = new Promise<void>((resolve) => {
        offChunk = window.api.onChatChunk((id) => {
          if (id !== requestId) return
        })
        offDone = window.api.onChatDone((id, result) => {
          if (id !== requestId) return
          if (result.status === 'finished') setStatus('连接成功')
          else if (result.status === 'stopped') setStatus('连接测试已停止')
          else setStatus(result.message)
          cleanup()
          resolve()
        })
      })
      await done
    } catch (error) {
      cleanup()
      setStatus(error instanceof Error ? error.message : '连接测试失败')
    }
  }

  function stopConnectionTest(): void {
    const requestId = testRequest.current
    if (requestId) void window.api.abortChat(requestId).catch(() => {})
  }

  return (
    <main className="settings" data-testid="settings-view">
      <header className="settings__header">
        <button type="button" onClick={onBack}>← 返回书架</button>
        <h1>设置</h1>
      </header>
      <section className="settings__form">
        <label>
          接口地址
          <input data-testid="settings-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.openai.com/v1" />
        </label>
        <label>
          模型名
          <input data-testid="settings-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
        </label>
        <label>
          API 密钥
          <input data-testid="settings-apikey" type="password" value={apiKey} onChange={(e) => setApiKeyInput(e.target.value)} autoComplete="new-password" />
          <small data-testid="settings-status">{keyConfigured ? '已设置' : '未设置'}{status ? ` · ${status}` : ''}</small>
          <button type="button" data-testid="settings-clear" onClick={() => void clearKey()} disabled={busy}>清除密钥</button>
        </label>
        <p className="settings__hint">接口地址改变后，出于安全考虑必须重新填写 API 密钥；留空密钥并保存会保持原密钥不变。</p>
        <label>
          系统提示词
          <textarea data-testid="settings-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} />
          <button type="button" onClick={() => setPrompt(DEFAULT_SYSTEM_PROMPT)}>恢复默认</button>
        </label>
        <label>
          上下文上限
          <input data-testid="settings-limit" type="number" min="1" step="1" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </label>
        <div className="settings__actions">
          <button type="button" data-testid="settings-save" onClick={() => void save()} disabled={busy || testing}>保存设置</button>
          <button type="button" data-testid="settings-test" onClick={() => testing ? stopConnectionTest() : void testConnection()} disabled={busy}>{testing ? '停止测试' : '测试连接'}</button>
        </div>
      </section>
    </main>
  )
}
