# 墨问 UI 风格

墨问采用“纸、墨、朱砂”的克制阅读风格。新功能优先复用 `theme.css` 的变量和现有按钮、卡片、弹窗结构，不单独发明颜色、圆角或阴影。

## 基础规则

- 颜色只用 `--bg`、`--bg-raised`、`--fg`、`--fg-muted`、`--accent`、`--danger`、`--success` 及对应 `-soft` 变量。
- 圆角只用 `--radius-sm`、`--radius`、`--radius-lg`；普通控件高度用 `--control-height`。
- 页面主操作用 `.button--primary`，次要操作用 `.button--secondary`，导航与低权重操作用 `.button--ghost`，纯图标用 `.button--icon`。
- 页面先显示标题与一句说明，再放内容卡片；同组字段放进 `.settings__section` 式的白色面板。
- 弹窗沿用 `.modal-overlay`、`.modal`、`.modal__actions`，危险确认按钮使用 `.button--danger`。
- 阅读内容和标题可用宋体；按钮、输入框和状态信息使用系统无衬线字体。
- 动画只表达层级变化，保持 120–180ms，并尊重 `prefers-reduced-motion`。

## 交互原则

- 每个页面只突出一个主操作。
- 错误使用浅红底，成功使用浅绿底；不要只靠颜色表达状态。
- 输入框、按钮必须保留清晰的键盘焦点样式和禁用状态。
- 新界面需同时检查浅色、深色，以及 900×600 的最小窗口尺寸。
