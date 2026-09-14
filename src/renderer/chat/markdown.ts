import DOMPurify from 'dompurify'
import { marked } from 'marked'

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.nodeName !== 'IMG' || (data.attrName !== 'src' && data.attrName !== 'srcset')) return
  if (data.attrName === 'srcset') {
    data.keepAttr = false
    return
  }
  try {
    const value = data.attrValue.trim()
    if (value.startsWith('data:image/')) return
    if (new URL(value, document.baseURI).origin === location.origin) return
  } catch {
    // Invalid URLs are not local resources.
  }
  data.keepAttr = false
})

/**
 * 把模型输出的 Markdown 渲染成 HTML,并消毒。
 *
 * 模型输出是不可信内容:它可能带着 <script> 或 onerror。渲染层拿不到
 * API 密钥(密钥只在主进程),但它能调用 preload 白名单里的全部方法,
 * 包括删书和删对话——所以这里必须消毒,不能省。
 */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    // 表单控件也一起禁掉:只移除外层 form 仍会留下可见密码框。
    FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option'],
    FORBID_ATTR: ['style']
  })
}
