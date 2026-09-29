import { useEffect, useState } from 'react'
import ConfirmDialog from '../ConfirmDialog'

interface BackupStatus { folder: string | null; lastBackup: string | null }

export default function BackupSettings() {
  const [config, setConfig] = useState<BackupStatus>({ folder: null, lastBackup: null })
  const [busy, setBusy] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.backupStatus().then((value) => { if (alive) setConfig(value) })
      .catch(() => { if (alive) { setError(true); setMessage('无法读取备份设置') } })
    return () => { alive = false }
  }, [])

  async function run(action: () => Promise<BackupStatus>, success: string): Promise<void> {
    setBusy(true)
    setMessage('')
    try {
      const value = await action()
      setConfig(value)
      setError(false)
      setMessage(success)
    } catch (cause) {
      setError(true)
      setMessage(cause instanceof Error ? cause.message : '备份操作失败')
    } finally { setBusy(false) }
  }

  async function restore(): Promise<void> {
    setConfirmRestore(false)
    setBusy(true)
    setMessage('正在验证备份…')
    try {
      const result = await window.api.restoreBackup()
      if (!result.restored) setMessage('已取消恢复')
    } catch (cause) {
      setError(true)
      setMessage(cause instanceof Error ? cause.message : '恢复失败，请重试')
    } finally { setBusy(false) }
  }

  return <section className="settings__section" data-testid="backup-settings">
    <div className="settings__section-head">
      <div><h2>云同步文件夹备份</h2><p>使用你自己的 iCloud、OneDrive、Dropbox 或其他同步文件夹；墨问不提供服务器。</p></div>
      <span className={`status-dot${config.folder ? ' status-dot--ready' : ''}`}>{config.folder ? '已选择位置' : '尚未设置'}</span>
    </div>
    <div className="backup-settings__body">
      <div className="backup-settings__location">
        <small>备份位置</small>
        <span title={config.folder ?? ''}>{config.folder ?? '先选择一个由云盘客户端同步的文件夹'}</span>
      </div>
      <div className="backup-settings__actions">
        <button type="button" className="button--secondary" data-testid="backup-choose" disabled={busy}
          onClick={() => void run(() => window.api.chooseBackupFolder(), '备份位置已更新')}>选择文件夹</button>
        <button type="button" className="button--primary" data-testid="backup-create" disabled={busy || !config.folder}
          onClick={() => void run(() => window.api.createBackup(), '完整备份已保存到同步文件夹；云端上传由同步客户端完成')}>{busy ? '处理中…' : '立即备份'}</button>
        <button type="button" className="button--ghost" data-testid="backup-restore" disabled={busy}
          onClick={() => setConfirmRestore(true)}>从备份恢复</button>
      </div>
      {config.lastBackup && <small className="backup-settings__last" title={config.lastBackup}>上次备份：{config.lastBackup}</small>}
      <p className="settings__hint">包含书籍、封面、阅读位置、注释、对话和设置；不包含本机加密的 API 密钥与可重新下载的离线翻译包、离线词典。备份未加密，请只选择信任的云盘；务必确认云盘客户端已完成上传。恢复会替换当前书库并自动重启，旧数据会留在本机以便回退。</p>
      {message && <p className={`settings__status${error ? ' settings__status--error' : ''}`} role="status" data-testid="backup-status">{message}</p>}
    </div>
    {confirmRestore && <ConfirmDialog title="从备份恢复书库？" message="请选择一个“墨问备份-…”文件夹。验证成功后会替换当前书籍、注释、对话和设置，并自动重启；原书库会留在应用数据目录的“恢复前数据”文件夹中。" confirmLabel="选择备份并恢复"
      onCancel={() => setConfirmRestore(false)} onConfirm={() => void restore()} testId="backup-restore-confirm" />}
  </section>
}
