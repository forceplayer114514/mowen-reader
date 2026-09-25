import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_SYSTEM_PROMPT,
  SETTING_KEYS
} from './defaults'

interface Props {
  onBack: () => void
}

export const CONNECTION_TEST_TIMEOUT_MS = 15_000

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
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testing, setTesting] = useState(false)
  const mounted = useRef(true)
  const testSequence = useRef(0)
  const testOperation = useRef<{
    token: number
    cancelled: boolean
    requestId: string | null
    timer: ReturnType<typeof setTimeout> | null
    offChunk: (() => void) | null
    offDone: (() => void) | null
    resolve: (() => void) | null
  } | null>(null)

  useEffect(() => {
    mounted.current = true
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
      mounted.current = false
      const operation = testOperation.current
      if (operation) {
        operation.cancelled = true
        if (operation.requestId) void window.api.abortChat(operation.requestId).catch(() => {})
        cleanupTest(operation)
      }
    }
  }, [])

  async function save(): Promise<boolean> {
    const parsedLimit = Number(limit)
    if (!endpoint.trim()) {
      if (mounted.current) setStatus('请填写接口地址')
      return false
    }
    if (!model.trim()) {
      if (mounted.current) setStatus('请填写模型名')
      return false
    }
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      if (mounted.current) setStatus('上下文上限必须是大于 0 的数字')
      return false
    }

    if (mounted.current) {
      setBusy(true)
      setStatus(null)
    }
    try {
      // Keep this order: the secret is encrypted with the endpoint currently in
      // the main-process settings table. A blank key intentionally leaves it alone.
      await window.api.setSetting(SETTING_KEYS.endpoint, endpoint.trim())
      if (apiKey.length > 0) {
        await window.api.setApiKey(apiKey)
        if (mounted.current) setApiKeyInput('')
      }
      await window.api.setSetting(SETTING_KEYS.model, model.trim())
      await window.api.setSetting(SETTING_KEYS.systemPrompt, prompt)
      await window.api.setSetting(SETTING_KEYS.contextLimit, String(parsedLimit))
      const configured = await window.api.hasApiKey()
      if (mounted.current) {
        setKeyConfigured(configured)
        setStatus('设置已保存')
      }
      return true
    } catch (error) {
      const configured = await window.api.hasApiKey().catch(() => false)
      if (mounted.current) {
        setKeyConfigured(configured)
        setStatus(error instanceof Error ? error.message : '设置保存失败')
      }
      return false
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function clearKey(): Promise<void> {
    if (!mounted.current) return
    setBusy(true)
    try {
      await window.api.clearApiKey()
      if (mounted.current) {
        setApiKeyInput('')
        setKeyConfigured(false)
        setStatus('API 密钥已清除')
      }
    } catch (error) {
      if (mounted.current) setStatus(error instanceof Error ? error.message : '清除密钥失败')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function fetchModels(): Promise<void> {
    const value = endpoint.trim()
    if (!value) {
      setStatus('请填写接口地址')
      return
    }
    setFetchingModels(true)
    setStatus('正在获取模型…')
    try {
      await window.api.setSetting(SETTING_KEYS.endpoint, value)
      if (apiKey.length > 0) {
        await window.api.setApiKey(apiKey)
        if (mounted.current) setApiKeyInput('')
      }
      const loaded = await window.api.listModels()
      const configured = await window.api.hasApiKey()
      if (!mounted.current) return
      if (loaded.endpoint !== value) {
        await window.api.setSetting(SETTING_KEYS.endpoint, loaded.endpoint)
        setEndpoint(loaded.endpoint)
      }
      setModels(loaded.models)
      setKeyConfigured(configured)
      setStatus(`已获取 ${loaded.models.length} 个模型，请从下拉列表选择`)
    } catch (error) {
      if (mounted.current) setStatus(error instanceof Error ? error.message : '获取模型失败')
    } finally {
      if (mounted.current) setFetchingModels(false)
    }
  }

  async function testConnection(): Promise<void> {
    if (testOperation.current || !mounted.current) return
    const operation = {
      token: ++testSequence.current,
      cancelled: false,
      requestId: null as string | null,
      timer: null as ReturnType<typeof setTimeout> | null,
      offChunk: null as (() => void) | null,
      offDone: null as (() => void) | null,
      resolve: null as (() => void) | null
    }
    testOperation.current = operation
    setTesting(true)
    setStatus('正在保存并测试连接…')
    try {
      if (!await save() || operation.cancelled || !mounted.current || testOperation.current !== operation) {
        cleanupTest(operation)
        if (mounted.current && !operation.cancelled) setTesting(false)
        return
      }
      const requestId = await window.api.startChat({
        messages: [{ role: 'user', content: '请只回复：连接成功。' }]
      })
      operation.requestId = requestId
      // The save/start handshake can outlive the component. Abort a late id,
      // but never attach listeners or update state for the abandoned operation.
      if (operation.cancelled || !mounted.current || testOperation.current !== operation) {
        void window.api.abortChat(requestId).catch(() => {})
        return
      }
      const done = new Promise<void>((resolve) => {
        operation.offChunk = window.api.onChatChunk((id) => {
          if (id !== operation.requestId || operation.cancelled) return
        })
        operation.offDone = window.api.onChatDone((id, result) => {
          if (id !== operation.requestId || operation.cancelled) return
          const current = mounted.current && testOperation.current === operation
          if (current) {
            if (result.status === 'finished') setStatus('连接成功')
            else if (result.status === 'stopped') setStatus('连接测试已停止')
            else setStatus(result.message)
          }
          cleanupTest(operation)
          if (current) setTesting(false)
        })
        operation.timer = setTimeout(() => {
          if (operation.cancelled || testOperation.current !== operation) return
          const current = mounted.current && testOperation.current === operation
          operation.cancelled = true
          if (operation.requestId) void window.api.abortChat(operation.requestId).catch(() => {})
          cleanupTest(operation)
          if (current) {
            setStatus('连接测试超时')
            setTesting(false)
          }
        }, CONNECTION_TEST_TIMEOUT_MS)
        operation.resolve = resolve
      })
      await done
    } catch (error) {
      const current = mounted.current && testOperation.current === operation
      if (current && !operation.cancelled) {
        setStatus(error instanceof Error ? error.message : '连接测试失败')
      }
      cleanupTest(operation)
      if (current) setTesting(false)
    }
  }

  function stopConnectionTest(): void {
    const operation = testOperation.current
    if (!operation) return
    operation.cancelled = true
    if (operation.requestId) void window.api.abortChat(operation.requestId).catch(() => {})
    cleanupTest(operation)
    if (mounted.current) {
      setStatus('连接测试已停止')
      setTesting(false)
    }
  }

  function cleanupTest(operation: NonNullable<typeof testOperation.current>): void {
    if (operation.timer !== null) clearTimeout(operation.timer)
    operation.timer = null
    operation.offChunk?.()
    operation.offDone?.()
    operation.offChunk = null
    operation.offDone = null
    const resolve = operation.resolve
    operation.resolve = null
    if (testOperation.current === operation) testOperation.current = null
    resolve?.()
  }

  return (
    <main className="settings" data-testid="settings-view">
      <header className="settings__header">
        <button type="button" className="button--ghost" onClick={onBack}>← 返回书架</button>
        <div>
          <p className="eyebrow">偏好设置</p>
          <h1>设置</h1>
        </div>
      </header>
      <section className="settings__form">
        <div className="settings__section">
          <div className="settings__section-head">
            <div>
              <h2>模型连接</h2>
              <p>连接任何兼容 OpenAI 格式的模型服务。</p>
            </div>
            <span className={`status-dot${keyConfigured ? ' status-dot--ready' : ''}`}>
              {keyConfigured ? '密钥已设置' : '尚未设置'}
            </span>
          </div>
          <div className="settings__fields">
            <label>
              <span>接口地址</span>
              <input data-testid="settings-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.openai.com/v1" />
            </label>
            <label>
              <span>API 密钥</span>
              <div className="field-with-action">
                <input data-testid="settings-apikey" type="password" value={apiKey} onChange={(e) => setApiKeyInput(e.target.value)} autoComplete="new-password" placeholder={keyConfigured ? '留空以保留现有密钥' : '输入 API 密钥'} />
                <button type="button" className="button--ghost" data-testid="settings-clear" onClick={() => void clearKey()} disabled={busy || fetchingModels}>清除</button>
              </div>
              <small>密钥仅保存在本机的系统加密存储中。</small>
            </label>
            <label>
              <span>模型</span>
              <div className="field-with-action">
                {models.length > 0 ? (
                  <select data-testid="settings-model" value={model} onChange={(e) => setModel(e.target.value)}>
                    {!models.includes(model) && model && <option value={model}>{model}</option>}
                    {!model && <option value="">请选择模型</option>}
                    {models.map((item) => <option value={item} key={item}>{item}</option>)}
                  </select>
                ) : (
                  <input data-testid="settings-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="获取模型后选择，或手动输入" />
                )}
                <button type="button" className="button--secondary" data-testid="settings-fetch-models" onClick={() => void fetchModels()} disabled={busy || testing || fetchingModels}>
                  {fetchingModels ? '获取中…' : '获取模型'}
                </button>
              </div>
            </label>
          </div>
          <p className="settings__hint">接口地址改变后需重新填写 API 密钥；留空密钥并保存会保留原密钥。</p>
          <div className={`settings__status${status?.includes('失败') || status?.includes('错误') ? ' settings__status--error' : ''}`} data-testid="settings-status" role="status" aria-live="polite">
            {status ?? '填写连接信息后，可以先获取模型或测试连通性。'}
          </div>
        </div>

        <div className="settings__section">
          <div className="settings__section-head">
            <div>
              <h2>对话偏好</h2>
              <p>控制回答风格和每次对话可使用的上下文。</p>
            </div>
          </div>
          <div className="settings__fields">
            <label>
              <span>系统提示词</span>
              <textarea data-testid="settings-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={7} />
              <button type="button" className="button--ghost settings__reset" onClick={() => setPrompt(DEFAULT_SYSTEM_PROMPT)}>恢复默认</button>
            </label>
            <label className="settings__compact-field">
              <span>上下文上限</span>
              <input data-testid="settings-limit" type="number" min="1" step="1" value={limit} onChange={(e) => setLimit(e.target.value)} />
              <small>按字符近似计算，超出时优先移除较早的问答。</small>
            </label>
          </div>
        </div>
        <div className="settings__actions">
          <button type="button" className="button--secondary" data-testid="settings-test" onClick={() => testing ? stopConnectionTest() : void testConnection()} disabled={busy || fetchingModels}>{testing ? '停止测试' : '测试连接'}</button>
          <button type="button" className="button--primary" data-testid="settings-save" onClick={() => void save()} disabled={busy || testing || fetchingModels}>保存设置</button>
        </div>
      </section>
    </main>
  )
}
