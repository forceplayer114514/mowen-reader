// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../src/renderer/chat/markdown'

describe('Markdown 渲染', () => {
  it('粗体变成 strong', () => {
    expect(renderMarkdown('**重点**')).toContain('<strong>重点</strong>')
  })

  it('列表变成 ul/li', () => {
    const html = renderMarkdown('- 第一项\n- 第二项')
    expect(html).toContain('<li>')
    expect(html).toContain('第一项')
  })

  it('代码块被保留', () => {
    expect(renderMarkdown('```\nconst a = 1\n```')).toContain('<code>')
  })

  it('script 标签被消掉', () => {
    const html = renderMarkdown('正常文字<script>window.api.deleteBook("x")</script>')
    expect(html).not.toContain('<script')
    expect(html).toContain('正常文字')
  })

  it('事件属性被消掉', () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).not.toContain('onerror')
  })

  it('javascript: 链接被消掉', () => {
    expect(renderMarkdown('[点我](javascript:alert(1))')).not.toContain('javascript:')
  })

  it('普通链接保留', () => {
    expect(renderMarkdown('[文档](https://example.com)')).toContain('https://example.com')
  })

  it('空字符串返回空', () => {
    expect(renderMarkdown('').trim()).toBe('')
  })

  it('纯文本里的尖括号被转义而不是当成标签', () => {
    expect(renderMarkdown('a < b 且 c > d')).not.toContain('<b ')
  })

  // 以下三条不在计划的清单里,是实测补上的:它们都是 USE_PROFILES: { html: true }
  // 恰好挡住、但换个配置就会放行的注入面。留着当回归哨兵。

  // svg 是另一个命名空间,里面的 script 和 onload 是真能执行的。现在整块被丢掉,
  // 是因为只开了 html 这一份白名单。哪天有人为了画图表把 svg 也打开,这条会先炸。
  it('svg 命名空间的载荷被整块消掉', () => {
    expect(renderMarkdown('<svg onload="alert(1)"></svg>')).not.toContain('<svg')
    const html = renderMarkdown('<svg><script>alert(1)</script></svg>')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<script')
  })

  // data: 协议能把一整张 HTML 文档塞进链接,点开就等于执行任意脚本,
  // 和 javascript: 是两类不同的绕过手法,得分开守。
  it('data: 协议的链接被消掉', () => {
    const html = renderMarkdown('[点我](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)')
    expect(html).not.toContain('data:')
    expect(html).toContain('点我')
  })

  // 把 j 写成实体 &#106; 是老套路:消毒时如果只做字符串匹配就会被绕过。
  // DOMPurify 是先交给解析器还原再判断,所以能拦住——这条钉住这个前提。
  it('实体编码伪装的 javascript: 链接同样被消掉', () => {
    const html = renderMarkdown('<a href="&#106;avascript:alert(1)">点我</a>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('href')
  })

  it('表单和 style 属性都被消毒', () => {
    const html = renderMarkdown('<form><input type="password"></form><p style="background:url(https://tracker.invalid/pixel)">字</p>')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('style=')
  })

  it('远程图片不保留 src,不会触发远程资源请求', () => {
    const html = renderMarkdown('![追踪](https://tracker.invalid/pixel.png)')
    expect(html).not.toContain('https://tracker.invalid')
  })

  it('协议相对图片和 srcset 都不放行', () => {
    const html = renderMarkdown('![追踪](//attacker.invalid/pixel.png)\n\n<img src="/local.png" srcset="//attacker.invalid/a 1x">')
    expect(html).not.toContain('attacker.invalid')
    expect(html).toContain('src="/local.png"')
    expect(html).not.toContain('srcset=')
  })

  it('渲染窗口的 CSP 只允许本地和 data 图片', () => {
    const html = readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8')
    expect(html).toContain("img-src 'self' data: blob:")
  })
})
