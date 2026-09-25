interface Props {
  disabled?: boolean
  merged?: boolean
  onClick: () => void
}

export default function MergeButton({ disabled = false, merged = false, onClick }: Props) {
  return (
    <button
      type="button"
      className={`merge-button${merged ? ' merge-button--active' : ''}`}
      data-testid="merge-next-page"
      disabled={disabled}
      onClick={onClick}
    >
      {merged ? '取消扩展' : '加入下一屏'}
    </button>
  )
}
