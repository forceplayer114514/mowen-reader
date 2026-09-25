import { useEffect, useRef } from 'react'

interface Props {
  title: string
  message: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
  busy?: boolean
  testId?: string
  confirmTestId?: string
}

export default function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm, busy = false, testId, confirmTestId }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  return (
    <div className="modal-overlay" data-testid={testId}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}>
        <div className="modal__symbol modal__symbol--danger">!</div>
        <h2>{title}</h2>
        <p className="modal__copy">{message}</p>
        <div className="modal__actions">
          <button type="button" ref={cancelRef} onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className="button--danger" data-testid={confirmTestId} onClick={onConfirm} disabled={busy}>
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
