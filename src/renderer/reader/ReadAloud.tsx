import { useEffect, useRef, useState } from 'react'
import type { ReaderEngine, VisibleRange } from './types'

let speechOwner: (() => void) | null = null
/** A book or translation may speak, never both. Returns an owner-checked release. */
export function claimSpeech(stop: () => void): () => boolean {
  speechOwner?.()
  speechOwner = stop
  return () => {
    if (speechOwner !== stop) return false
    speechOwner = null
    return true
  }
}

/** Chromium's speech engine is unreliable with very long utterances. */
export function speechChunks(text: string, size = 180): string[] {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  const chunks: string[] = []
  for (let i = 0; i < chars.length; i += size) chunks.push(chars.slice(i, i + size).join(''))
  return chunks
}

interface Props {
  visible: VisibleRange | null
  onNext: () => void
  engine: ReaderEngine | null
  unavailableReason?: string
  onPickPosition?: () => void
}

export default function ReadAloud({ visible, onNext, engine, unavailableReason, onPickPosition }: Props) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<'stopped' | 'playing' | 'paused'>('stopped')
  const [rate, setRate] = useState(1)
  const [voiceUri, setVoiceUri] = useState('')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [notice, setNotice] = useState('')
  const [picking, setPicking] = useState(false)
  const token = useRef(0)
  const currentCfi = useRef('')
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = useRef(false)
  const releaseSpeech = useRef<(() => boolean) | null>(null)
  const nextRef = useRef(onNext)
  nextRef.current = onNext
  const voiceRef = useRef(voiceUri)
  voiceRef.current = voiceUri
  const rateRef = useRef(rate)
  rateRef.current = rate

  function stop(): void {
    active.current = false
    token.current++
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    advanceTimer.current = null
    if (releaseSpeech.current?.()) window.speechSynthesis?.cancel()
    releaseSpeech.current = null
    setPicking(false)
    setState('stopped')
  }

  function speakPage(page: VisibleRange, fromHere?: string): void {
    if (page.approximate) {
      stop()
      setNotice('此处跨章节，无法准确提取当前页文字。请翻一页后重试。')
      return
    }
    const chunks = speechChunks(fromHere ?? page.text)
    if (!chunks.length) {
      stop()
      setNotice('当前页没有可朗读的文字。')
      return
    }
    releaseSpeech.current = claimSpeech(stop)
    active.current = true
    const id = ++token.current
    window.speechSynthesis.cancel()
    currentCfi.current = page.startCfi
    setNotice('')
    setState('playing')
    function speak(index: number): void {
      if (id !== token.current || !active.current) return
      if (index === chunks.length) {
        if (page.readProgress >= 1) { stop(); return }
        nextRef.current()
        // Last page can refuse to turn without emitting a relocation.
        advanceTimer.current = setTimeout(() => {
          if (id === token.current) stop()
        }, 2000)
        return
      }
      const utterance = new SpeechSynthesisUtterance(chunks[index])
      utterance.rate = rateRef.current
      utterance.voice = voices.find((voice) => voice.voiceURI === voiceRef.current) ?? null
      utterance.onend = () => speak(index + 1)
      utterance.onerror = (event) => {
        if (id !== token.current || event.error === 'canceled' || event.error === 'interrupted') return
        stop()
        setNotice('朗读失败，请检查系统语音是否可用。')
      }
      window.speechSynthesis.speak(utterance)
    }
    speak(0)
  }

  useEffect(() => {
    if (!picking || !engine) return
    return engine.onReadPosition((text) => {
      if (!visible) return
      setPicking(false)
      speakPage(visible, text)
    })
  }, [picking, engine, visible])

  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const refresh = (): void => setVoices(window.speechSynthesis.getVoices())
    refresh()
    window.speechSynthesis.addEventListener('voiceschanged', refresh)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh)
  }, [])

  useEffect(() => {
    if (!active.current || !visible || visible.startCfi === currentCfi.current) return
    if (state === 'paused') { stop(); return }
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    advanceTimer.current = null
    speakPage(visible)
  }, [visible, state])

  useEffect(() => () => {
    active.current = false
    token.current++
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    if (releaseSpeech.current?.()) window.speechSynthesis?.cancel()
  }, [])

  function toggle(): void {
    if (state === 'playing') {
      window.speechSynthesis.pause()
      setState('paused')
    } else if (state === 'paused') {
      window.speechSynthesis.resume()
      setState('playing')
    } else if (visible && 'speechSynthesis' in window) {
      speakPage(visible)
    }
  }

  return (
    <div className="read-aloud">
      <button type="button" className="button--ghost" data-testid="read-aloud-toggle" aria-expanded={open}
        disabled={Boolean(unavailableReason) && state === 'stopped'} title={unavailableReason}
        aria-pressed={state !== 'stopped'} onClick={() => setOpen((value) => !value)}>
        {state === 'playing' ? '朗读中' : state === 'paused' ? '已暂停' : '朗读'}
      </button>
      {open && <div className="read-aloud__panel" data-testid="read-aloud-panel">
        <div className="read-aloud__heading">语音朗读 <span>系统语音 · 连续翻页</span></div>
        <div className="read-aloud__actions">
          <button type="button" className="button--primary" data-testid="read-aloud-play" disabled={!visible || !visible.text.trim() || !('speechSynthesis' in window)} onClick={toggle}>
            {state === 'playing' ? '暂停' : state === 'paused' ? '继续' : '开始朗读'}
          </button>
          <button type="button" className="button--secondary" data-testid="read-aloud-stop" disabled={state === 'stopped'} onClick={stop}>停止</button>
        </div>
        <button type="button" className="button--secondary" data-testid="read-aloud-pick"
          disabled={!visible || !visible.text.trim() || visible.approximate || !engine || !('speechSynthesis' in window)}
          aria-pressed={picking}
          onClick={() => { if (picking) setPicking(false); else { stop(); onPickPosition?.(); setPicking(true); setNotice('请点击当前页要开始朗读的文字。') } }}>
          {picking ? '取消点选' : '点选正文起点'}
        </button>
        <label>语速 <select aria-label="朗读语速" value={rate} onChange={(event) => setRate(Number(event.target.value))}>
          <option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option>
        </select></label>
        <label>声音 <select aria-label="朗读声音" value={voiceUri} onChange={(event) => setVoiceUri(event.target.value)}>
          <option value="">系统默认</option>
          {voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
        </select></label>
        {notice && <p role="status" className="read-aloud__notice">{notice}</p>}
      </div>}
    </div>
  )
}
