interface Props {
  disabled?: boolean
  onClick: () => void
}

export default function MergeButton({ disabled = false, onClick }: Props) {
  return (
    <button
      type="button"
      data-testid="merge-next-page"
      disabled={disabled}
      onClick={onClick}
    >
      合并下一页
    </button>
  )
}
