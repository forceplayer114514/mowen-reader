import { describe, expect, it } from 'vitest'
import { buildContext, type ContextInput } from '../../src/renderer/chat/context'
import type { TocItem, VisibleRange } from '../../src/renderer/reader/types'

function visible(over: Partial<VisibleRange> = {}): VisibleRange {
  return {
    text: '他终于明白过来,原来那天的雨下得那样久。',
    startCfi: 'epubcfi(/6/4!/4/2/2/1:0)',
    endCfi: 'epubcfi(/6/4!/4/2/8/1:0)',
    rangeCfi: 'epubcfi(/6/4!/4/2,/2/1:0,/8/1:0)',
    approximate: false,
    chapterHref: 'Text/ch3.xhtml',
    chapterLabel: '第三章 那个夏天',
    page: 47,
    totalPages: 300,
    ...over
  }
}

function toc(n: number): TocItem[] {
  return Array.from({ length: n }, (_, i) => ({
    label: `第${i + 1}章 标题${i + 1}`,
    href: `Text/ch${i + 1}.xhtml`,
    depth: 0
  }))
}

function input(over: Partial<ContextInput> = {}): ContextInput {
  return {
    systemPrompt: '你是阅读助手。',
    bookTitle: '测试之书',
    author: '测试作者',
    visible: visible(),
    toc: toc(3),
    quotes: [],
    history: [],
    userText: '这句话什么意思',
    limit: 8000,
    ...over
  }
}

function systemOf(r: ReturnType<typeof buildContext>): string {
  return r.messages[0].content
}

describe('上下文拼装', () => {
  it('第一条是系统消息,里面有系统提示词、书名和作者', () => {
    const r = buildContext(input())
    expect(r.messages[0].role).toBe('system')
    expect(systemOf(r)).toContain('你是阅读助手。')
    expect(systemOf(r)).toContain('测试之书')
    expect(systemOf(r)).toContain('测试作者')
  })

  it('最后一条是本轮提问', () => {
    const r = buildContext(input())
    const last = r.messages[r.messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toContain('这句话什么意思')
  })

  it('当前页正文进系统消息', () => {
    const r = buildContext(input())
    expect(systemOf(r)).toContain('他终于明白过来')
  })

  it('目录与章节名都可得时,两者一起加入', () => {
    const r = buildContext(input())
    expect(systemOf(r)).toContain('第三章 那个夏天')
    expect(systemOf(r)).toContain('第1章 标题1')
  })

  it('目录为空时,章节名也不加入——增强层缺一不可', () => {
    const r = buildContext(input({ toc: [] }))
    expect(systemOf(r)).not.toContain('第三章 那个夏天')
  })

  it('章节名为空时,目录也不加入', () => {
    const r = buildContext(input({ visible: visible({ chapterLabel: null }) }))
    expect(systemOf(r)).not.toContain('第1章 标题1')
  })

  it('作者为空时不写出"作者:null"这种东西', () => {
    const r = buildContext(input({ author: null }))
    expect(systemOf(r)).not.toContain('null')
  })

  it('正文是近似值时,标题明确说明这不是一屏可见内容', () => {
    const r = buildContext(input({ visible: visible({ approximate: true }) }))
    expect(systemOf(r)).toContain('可见范围跨章')
    expect(systemOf(r)).not.toContain('当前页内容')
  })

  it('引用句子附在本轮提问里', () => {
    const r = buildContext(
      input({ quotes: [{ cfiRange: 'x', text: '雨下得那样久' }] })
    )
    const last = r.messages[r.messages.length - 1].content
    expect(last).toContain('雨下得那样久')
    expect(last).toContain('这句话什么意思')
  })

  it('多条引用按顺序全部附上', () => {
    const r = buildContext(
      input({
        quotes: [
          { cfiRange: 'a', text: '第一句' },
          { cfiRange: 'b', text: '第二句' }
        ]
      })
    )
    const last = r.messages[r.messages.length - 1].content
    expect(last.indexOf('第一句')).toBeLessThan(last.indexOf('第二句'))
  })

  it('历史问答夹在系统消息和本轮提问之间,顺序不变', () => {
    const r = buildContext(
      input({
        history: [
          { role: 'user', content: '第一问' },
          { role: 'assistant', content: '第一答' }
        ]
      })
    )
    expect(r.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(r.messages[1].content).toBe('第一问')
  })

  it('装得下时不做任何裁剪', () => {
    expect(buildContext(input()).trimmed).toEqual([])
  })
})

describe('超限裁剪', () => {
  it('第一步把目录裁成当前章节前后各 5 条', () => {
    const big = toc(60)
    const r = buildContext(
      input({
        toc: big,
        visible: visible({ chapterHref: 'Text/ch30.xhtml', chapterLabel: '第30章 标题30' }),
        limit: 400
      })
    )
    expect(r.trimmed).toContain('toc-local')
    expect(systemOf(r)).toContain('第30章 标题30')
    expect(systemOf(r)).toContain('第25章 标题25')
    expect(systemOf(r)).not.toContain('第1章 标题1')
  })

  it('目录条数不超过窗口大小(11 条)时,也要先试着裁成局部,不能因为条数少就跳过', () => {
    // 目录只有 11 条,不比窗口大小(当前章节前后各 5 条 = 11 条)多,
    // 但裁成局部窗口后仍然从 11 条变成 6 条(当前章节在最前面,窗口被开头截断),
    // 能省下的量比直接去删对话历史划算,所以这一步不该因为"条数不超过窗口"被跳过。
    const label = (i: number): string => `第${i}章 标题${i}长一点点内容撑起字数`
    const elevenToc: TocItem[] = Array.from({ length: 11 }, (_, i) => ({
      label: label(i + 1),
      href: `Text/ch${i + 1}.xhtml`,
      depth: 0
    }))
    const r = buildContext(
      input({
        toc: elevenToc,
        visible: visible({ chapterHref: 'Text/ch1.xhtml', chapterLabel: label(1) }),
        history: [
          { role: 'user', content: '之前问的问题内容' },
          { role: 'assistant', content: '之前的回答内容也不短' }
        ],
        limit: 200
      })
    )
    expect(r.trimmed).toContain('toc-local')
    expect(r.trimmed).not.toContain('drop-history')
    expect(systemOf(r)).toContain(label(1))
    expect(systemOf(r)).not.toContain(label(11))
  })

  it('第二步删最早的一轮问答,成对删除', () => {
    const history = [
      { role: 'user' as const, content: '很早的问题'.repeat(40) },
      { role: 'assistant' as const, content: '很早的回答'.repeat(40) },
      { role: 'user' as const, content: '最近的问题' },
      { role: 'assistant' as const, content: '最近的回答' }
    ]
    const r = buildContext(input({ history, limit: 220 }))
    expect(r.trimmed).toContain('drop-history')
    const joined = r.messages.map((m) => m.content).join('')
    expect(joined).not.toContain('很早的问题')
    expect(joined).toContain('最近的问题')
  })

  it('历史不是完美的一问一答交替时,按"轮"删而不是按位置删两条', () => {
    // 历史形状是 [问A, 问B, 答B, 答旧](两个问题排在一起)。按位置删前两条
    // 会把问A和问B一起删掉,还会让剩下的历史以 assistant 开头;
    // 按"轮"删只删掉问A(它后面紧跟的问B不是 assistant,不用连带删),
    // 问B和它的答都还在,且剩下的历史仍以 user 开头。
    const history = [
      { role: 'user' as const, content: '问题甲内容较长一些'.repeat(6) },
      { role: 'user' as const, content: '问题乙内容较长一些'.repeat(6) },
      { role: 'assistant' as const, content: '回答乙内容较长一些'.repeat(6) },
      { role: 'assistant' as const, content: '回答旧内容较长一些'.repeat(6) }
    ]
    const r = buildContext(input({ history, limit: 300 }))
    const roles = r.messages.map((m) => m.role)
    expect(roles[1]).not.toBe('assistant')
    expect(roles).toEqual(['system', 'user', 'assistant', 'assistant', 'user'])
    const joined = r.messages.map((m) => m.content).join('')
    expect(joined).not.toContain('问题甲')
    expect(joined).toContain('问题乙')
    expect(joined).toContain('回答乙')
    expect(joined).toContain('回答旧')
  })

  it('第三步把目录整个丢掉', () => {
    const r = buildContext(input({ toc: toc(200), limit: 100 }))
    expect(r.trimmed).toContain('toc-dropped')
    expect(systemOf(r)).not.toContain('标题1')
  })

  it('裁剪按顺序执行,先局部目录再删历史', () => {
    const history = [
      { role: 'user' as const, content: '早问'.repeat(50) },
      { role: 'assistant' as const, content: '早答'.repeat(50) }
    ]
    const r = buildContext(input({ toc: toc(60), history, limit: 300 }))
    expect(r.trimmed.indexOf('toc-local')).toBeLessThan(r.trimmed.indexOf('drop-history'))
  })

  it('书名、作者、章节名、正文、引用永远不被裁掉', () => {
    const r = buildContext(
      input({
        toc: toc(200),
        quotes: [{ cfiRange: 'a', text: '必须保留的引用' }],
        history: Array.from({ length: 20 }, (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `历史${i}`.repeat(20)
        })),
        limit: 200
      })
    )
    const joined = r.messages.map((m) => m.content).join('')
    expect(joined).toContain('测试之书')
    expect(joined).toContain('测试作者')
    expect(joined).toContain('他终于明白过来')
    expect(joined).toContain('必须保留的引用')
  })

  it('全裁完仍然超限时抛出中文错误,而不是静默截断正文', () => {
    expect(() =>
      buildContext(input({ visible: visible({ text: '很长的正文'.repeat(500) }), limit: 100 }))
    ).toThrow(/超出/)
  })

  it('抛错时不会先把正文截断再抛', () => {
    try {
      buildContext(input({ visible: visible({ text: '正'.repeat(5000) }), limit: 100 }))
      throw new Error('本该抛错')
    } catch (e) {
      expect((e as Error).message).toMatch(/当前页文字量超出/)
    }
  })
})
