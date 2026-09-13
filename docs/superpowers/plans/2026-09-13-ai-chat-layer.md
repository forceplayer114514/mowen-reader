# AI 阅读器 · 计划二:AI 对话层 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在计划一交付的 EPUB 阅读器上加一层 AI 对话侧边栏:上下文自动跟随阅读位置(书名+作者+当前页,可用时加目录和章节名),鼠标划选句子作为引用,翻页开新对话、翻回去看旧对话,对话按文字位置锚定因而不受字号变化影响。

**Architecture:** 主进程新增三个模块:`secrets`(API key 走 Electron safeStorage 加密落盘)、`llm`(OpenAI 兼容接口的流式请求与错误分类)、对话与消息两张表。渲染进程新增 `context`(上下文拼装与四级裁剪,纯函数)、`selection`(划选高亮)和侧边栏界面。API key 永不进入渲染进程:界面只发"把这组消息发出去",主进程取密钥、调接口、把文字块流回来。

**Tech Stack:** 沿用计划一(Electron 44 · electron-vite 2 · TypeScript strict · React 19 · epub.js · node:sqlite · Vitest · Playwright),新增 `marked` + `dompurify` 渲染 Markdown。

## Global Constraints

- Node ≥ 22.13,且 Electron 自带的 Node 必须提供 `node:sqlite`(当前锁定 electron ^44.3.0,自带 Node 24)。数据库层全程零原生模块编译。
- TypeScript `strict: true`。
- 渲染进程 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。渲染层只能调用 preload 白名单里的方法。
- **API key 永不进入渲染进程。** 渲染层不得有任何读取或持有密钥的通道。密钥只经 `secrets` 模块在主进程内取用。
- 主进程里所有文件系统路径必须由校验过的书籍 id 或数据库行派生,不得采信渲染层传入的路径。
- 只支持 EPUB。
- 所有用户可见文案用简体中文。
- epub.js 只能从 `src/renderer/reader/` 目录下的文件里 import。该目录之外的任何文件出现 `from 'epubjs'` 视为违规。
- 页码 = epub.js locations 索引 + 1,不随字号变化。**对话锚定一律用 CFI 文字位置,不得用页码。**
- `VisibleRange.approximate` 为 true 时 `text` 是整章全文而非一屏可见内容。拼装上下文时必须据此改写描述,不得把它当作"屏幕上精确可见的文字"喂给模型。
- 每个任务结束必须提交一次 git commit。
- 不得削弱或跳过计划一留下的 129 个单元测试与 12 个端到端测试。

## 计划一已定型、本计划直接消费的接口

```ts
// src/renderer/reader/types.ts
interface VisibleRange {
  text: string; startCfi: string; endCfi: string; rangeCfi: string
  approximate: boolean; chapterHref: string; chapterLabel: string | null
  page: number; totalPages: number
}
interface TocItem { label: string; href: string; depth: number }
interface ReaderEngine {
  open(data, opts): Promise<void>; display(target?): Promise<void>
  next(): Promise<void>; prev(): Promise<void>; setSpread(on: boolean): Promise<void>
  setFontSize(px: number): void; setTheme(name): void
  getVisible(): Promise<VisibleRange>; toc(): TocItem[]
  currentCfi(): string | null; exportLocations(): string | null
  onRelocated(cb: () => void): () => void
  onKey(cb: (key: string) => void): () => void
  destroy(): void
}

// src/renderer/reader/cfi.ts
export function compareCfiPositions(cfiA: string, cfiB: string): number  // 仅同章节内可比
export function makeRangeCfi(startCfi: string, endCfi: string): string

// src/main/db/index.ts
export const SCHEMA_VERSION = 1        // 本计划提升到 2
export function openDatabase(file: string): Db
```

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/renderer/reader/cfi.ts` | **扩充**:新增跨章节可比的全序比较 |
| `src/renderer/reader/anchor.ts` | 新增:判断一个旧对话是否属于当前页 |
| `src/main/db/index.ts` | **扩充**:加两张表,schema 版本提到 2 |
| `src/main/db/conversations.ts` | 新增:对话与消息的读写 |
| `src/main/secrets.ts` | 新增:API key 加密存取 |
| `src/main/llm/sse.ts` | 新增:SSE 流解析(纯函数) |
| `src/main/llm/errors.ts` | 新增:错误分类(纯函数) |
| `src/main/llm/client.ts` | 新增:OpenAI 兼容流式请求 |
| `src/main/ipc.ts` | **扩充**:对话、密钥、模型调用的通道 |
| `src/preload/index.ts` | **扩充**:对应的白名单方法 |
| `src/shared/types.ts` | **扩充**:对话相关类型 |
| `src/renderer/chat/context.ts` | 新增:上下文拼装与四级裁剪(纯函数) |
| `src/renderer/chat/tokens.ts` | 新增:长度估算(纯函数) |
| `src/renderer/chat/markdown.ts` | 新增:Markdown 渲染与消毒 |
| `src/renderer/chat/Sidebar.tsx` | 新增:侧边栏容器 |
| `src/renderer/chat/ConversationView.tsx` | 新增:当前对话区(消息流、输入框、停止、重试) |
| `src/renderer/chat/HistoryList.tsx` | 新增:本章历史对话折叠列表 |
| `src/renderer/chat/AllConversationsDialog.tsx` | 新增:全书对话弹层 |
| `src/renderer/reader/selection.ts` | 新增:划选高亮管理 |
| `src/renderer/reader/engine.ts` | **扩充**:划选与高亮的引擎接口 |
| `src/renderer/settings/SettingsView.tsx` | 新增:设置页 |
| `src/renderer/library/ConversationsView.tsx` | 新增:书库里的对话管理页 |
| `tests/e2e/fake-llm.ts` | 新增:端到端用的假模型服务 |

---

### Task 1: 跨章节 CFI 全序比较与对话归属判断

**Files:**
- Modify: `src/renderer/reader/cfi.ts`
- Create: `src/renderer/reader/anchor.ts`
- Test: `tests/unit/cfi.test.ts`(扩充)
- Test: `tests/unit/anchor.test.ts`

**Interfaces:**
- Consumes: `cfi.ts` 现有的 `compareCfiPositions`(仅同章节)
- Produces:
  - `compareCfi(a: string, b: string): number` — 跨章节可比的全序比较。先比 `!` 之前的章节路径,再比章节内路径,最后比字符偏移。
  - `conversationsOnPage<T extends { startCfi: string }>(all: T[], pageStartCfi: string, pageEndCfi: string): T[]` — 起点落在 `[pageStart, pageEnd]` 闭区间内的对话,按起点升序。

**为什么这是第一个任务:** 整个产品的"翻回去能看到当时聊的"全靠它。页码随字号变,CFI 不变;归属判断错了表现为"对话莫名其妙消失或出现在错的页",是设计文档点名的"最难复现的缺陷"。它是纯字符串运算,可以脱离浏览器完整测试。

- [ ] **Step 1: 写失败的测试**

`tests/unit/anchor.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { conversationsOnPage } from '../../src/renderer/reader/anchor'

const c = (id: string, startCfi: string) => ({ id, startCfi })

describe('对话归属当前页', () => {
  it('起点落在页范围内的被选出', () => {
    const all = [c('a', 'epubcfi(/6/4!/4/2/2/1:0)'), c('b', 'epubcfi(/6/4!/4/2/8/1:0)')]
    const got = conversationsOnPage(all, 'epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/6/1:0)')
    expect(got.map((x) => x.id)).toEqual(['a'])
  })

  it('页首页尾是闭区间,边界上的对话算这一页', () => {
    const all = [c('头', 'epubcfi(/6/4!/4/2/2/1:0)'), c('尾', 'epubcfi(/6/4!/4/2/6/1:0)')]
    const got = conversationsOnPage(all, 'epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/6/1:0)')
    expect(got.map((x) => x.id)).toEqual(['头', '尾'])
  })

  it('一页可以装下多个旧对话,按起点先后返回', () => {
    const all = [c('后', 'epubcfi(/6/4!/4/2/6/1:0)'), c('前', 'epubcfi(/6/4!/4/2/2/1:0)')]
    const got = conversationsOnPage(all, 'epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/8/1:0)')
    expect(got.map((x) => x.id)).toEqual(['前', '后'])
  })

  it('别的章节的对话不会混进来', () => {
    const all = [c('本章', 'epubcfi(/6/4!/4/2/2/1:0)'), c('下一章', 'epubcfi(/6/6!/4/2/2/1:0)')]
    const got = conversationsOnPage(all, 'epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/8/1:0)')
    expect(got.map((x) => x.id)).toEqual(['本章'])
  })

  it('页范围跨章节时,两章里的对话都能选出来', () => {
    const all = [
      c('前章', 'epubcfi(/6/4!/4/2/8/1:0)'),
      c('后章', 'epubcfi(/6/6!/4/2/2/1:0)'),
      c('更后', 'epubcfi(/6/8!/4/2/2/1:0)')
    ]
    const got = conversationsOnPage(all, 'epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/6!/4/2/4/1:0)')
    expect(got.map((x) => x.id)).toEqual(['前章', '后章'])
  })

  it('起点 CFI 坏掉的对话被跳过,不拖垮整页', () => {
    const all = [c('坏的', '不是CFI'), c('好的', 'epubcfi(/6/4!/4/2/2/1:0)')]
    const got = conversationsOnPage(all, 'epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/8/1:0)')
    expect(got.map((x) => x.id)).toEqual(['好的'])
  })

  it('页范围本身坏掉时返回空,而不是抛错', () => {
    const all = [c('a', 'epubcfi(/6/4!/4/2/2/1:0)')]
    expect(conversationsOnPage(all, '坏', 'epubcfi(/6/4!/4/2/8/1:0)')).toEqual([])
  })
})
```

在 `tests/unit/cfi.test.ts` 末尾追加(记得把 `compareCfi` 加进该文件的 import):

```ts
describe('跨章节 CFI 全序比较', () => {
  it('章节靠前的排在前面', () => {
    expect(compareCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/6!/4/2/2/1:0)')).toBeLessThan(0)
    expect(compareCfi('epubcfi(/6/6!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/2/1:0)')).toBeGreaterThan(0)
  })

  it('同章节内按路径比', () => {
    expect(compareCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/8/1:0)')).toBeLessThan(0)
  })

  it('路径相同时按字符偏移比', () => {
    expect(compareCfi('epubcfi(/6/4!/4/2/2/1:3)', 'epubcfi(/6/4!/4/2/2/1:9)')).toBeLessThan(0)
  })

  it('完全相同返回 0', () => {
    const x = 'epubcfi(/6/4!/4/2/2/1:3)'
    expect(compareCfi(x, x)).toBe(0)
  })

  it('路径是另一条的前缀时,短的排前面', () => {
    expect(compareCfi('epubcfi(/6/4!/4/2)', 'epubcfi(/6/4!/4/2/2/1:0)')).toBeLessThan(0)
  })

  it('缺失偏移与显式 :0 视为同一位置', () => {
    expect(compareCfi('epubcfi(/6/4!/4/2/2/1)', 'epubcfi(/6/4!/4/2/2/1:0)')).toBe(0)
  })

  it('章节号是数值比较不是字符串比较', () => {
    // 字符串比较会把 /6/10 排在 /6/4 前面,数值比较不会
    expect(compareCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/10!/4/2/2/1:0)')).toBeLessThan(0)
  })

  it('不是合法 CFI 时抛出可读的错误', () => {
    expect(() => compareCfi('随便', 'epubcfi(/6/4!/4/2/2/1:0)')).toThrow(/CFI/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx --no-install vitest run tests/unit/anchor.test.ts tests/unit/cfi.test.ts`
Expected: FAIL — `compareCfi` 未导出,`anchor` 模块不存在

- [ ] **Step 3: 实现全序比较**

在 `src/renderer/reader/cfi.ts` 里,复用文件内已有的 `split()`(它把 CFI 拆成 `base` 与 `part`)和已有的步进比较逻辑,新增导出:

```ts
/** 把章节路径(`!` 之前那段)拆成数字步进,用于跨章节比较。 */
function baseSteps(base: string): number[] {
  return base
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => Number(s.split('[')[0]))
}

function compareNumberLists(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * 跨章节可比的 CFI 全序比较:先比章节路径,同章节再比章节内路径与字符偏移。
 * 与 compareCfiPositions 的区别是它不要求两个 CFI 在同一章节。
 * 缺失的字符偏移按 0 处理——这与 compareCfiPositions 的语义保持一致。
 */
export function compareCfi(a: string, b: string): number {
  const left = split(a)
  const right = split(b)
  const byChapter = compareNumberLists(baseSteps(left.base), baseSteps(right.base))
  if (byChapter !== 0) return byChapter
  return compareCfiPositions(a, b)
}
```

若现有 `compareCfiPositions` 在两个 base 不同的输入上会抛错或给出无意义结果,上面先比章节的顺序已经保证它只在同章节时被调用。请读一遍该函数确认这一点,并在报告里说明。

- [ ] **Step 4: 实现归属判断**

`src/renderer/reader/anchor.ts`:

```ts
import { compareCfi } from './cfi'

/**
 * 挑出起点落在当前页文字范围内的对话。
 *
 * 页码随字号变化,CFI 不变,所以对话一律锚定到文字位置。判断规则是
 * "对话起点落在本页起止位置的闭区间内":一页可以装下过去的多个对话,
 * 横跨两页的旧对话归到它起点所在的那一页。
 *
 * 起点 CFI 损坏的对话被跳过而不是抛错——数据库里的历史数据可能来自
 * 旧版本或已被外部改动,一条坏记录不该让整页的历史都显示不出来。
 */
export function conversationsOnPage<T extends { startCfi: string }>(
  all: T[],
  pageStartCfi: string,
  pageEndCfi: string
): T[] {
  let lo: string
  let hi: string
  try {
    lo = compareCfi(pageStartCfi, pageEndCfi) <= 0 ? pageStartCfi : pageEndCfi
    hi = lo === pageStartCfi ? pageEndCfi : pageStartCfi
  } catch {
    return []
  }

  const usable: T[] = []
  for (const item of all) {
    try {
      if (compareCfi(item.startCfi, lo) >= 0 && compareCfi(item.startCfi, hi) <= 0) {
        usable.push(item)
      }
    } catch {
      // 起点坏掉的记录跳过
    }
  }
  return usable.sort((x, y) => compareCfi(x.startCfi, y.startCfi))
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS — 计划一的 129 个 + 本任务新增的全部通过

- [ ] **Step 6: 验证测试是真的**

把 `compareCfi` 里的 `if (byChapter !== 0) return byChapter` 临时删掉,重跑 `npx --no-install vitest run tests/unit/anchor.test.ts tests/unit/cfi.test.ts`,确认跨章节相关用例变红,再恢复并确认转绿。把三次输出贴进报告。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: compare cfis across chapters and anchor conversations to a page"
```

---

### Task 2: 对话与消息两张表

**Files:**
- Modify: `src/main/db/index.ts`
- Create: `src/main/db/conversations.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/unit/db-conversations.test.ts`
- Test: `tests/unit/db-index.test.ts`(扩充迁移用例)

**Interfaces:**
- Consumes: `openDatabase(file)`、`SCHEMA_VERSION`
- Produces:

```ts
// src/shared/types.ts
export interface ConversationRecord {
  id: string
  bookId: string
  startCfi: string
  endCfi: string
  /** 「合并下一页」时扩展到的终点;没合并过为 null */
  mergedEndCfi: string | null
  chapterLabel: string | null
  /** 该页开头 20 字,供对话管理页辨认 */
  excerpt: string
  createdAt: number
}

export interface QuoteRecord { cfiRange: string; text: string }

export interface MessageRecord {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  quotes: QuoteRecord[]
  createdAt: number
}

export interface ConversationWithCount extends ConversationRecord { messageCount: number }
```

```ts
// src/main/db/conversations.ts
insertConversation(db, c: ConversationRecord): void
updateConversationMerge(db, id: string, mergedEndCfi: string | null): void
listConversations(db, bookId: string): ConversationWithCount[]   // 按 createdAt 升序
getConversation(db, id: string): ConversationRecord | null
deleteConversations(db, ids: string[]): void                      // 批量,连带删消息
countConversations(db, bookId: string): number
insertMessage(db, m: MessageRecord): void
listMessages(db, conversationId: string): MessageRecord[]         // 按 createdAt 升序
```

- [ ] **Step 1: 写失败的测试**

`tests/unit/db-conversations.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import {
  countConversations,
  deleteConversations,
  getConversation,
  insertConversation,
  insertMessage,
  listConversations,
  listMessages,
  updateConversationMerge
} from '../../src/main/db/conversations'
import type { ConversationRecord, MessageRecord } from '../../src/shared/types'

function conv(id: string, over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id,
    bookId: '书1',
    startCfi: `epubcfi(/6/4!/4/2/2/1:0)`,
    endCfi: `epubcfi(/6/4!/4/2/8/1:0)`,
    mergedEndCfi: null,
    chapterLabel: '第三章 那个夏天',
    excerpt: '他终于明白过来',
    createdAt: 1000,
    ...over
  }
}

function msg(id: string, convId: string, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id,
    conversationId: convId,
    role: 'user',
    content: '这句话什么意思',
    quotes: [],
    createdAt: 2000,
    ...over
  }
}

describe('对话表', () => {
  it('插入后能按 id 取回,字段一致', () => {
    const db = openDatabase(':memory:')
    insertConversation(db, conv('a'))
    expect(getConversation(db, 'a')).toEqual(conv('a'))
    db.close()
  })

  it('取不存在的对话返回 null', () => {
    const db = openDatabase(':memory:')
    expect(getConversation(db, '没有')).toBeNull()
    db.close()
  })

  it('列表按创建时间升序,并带上消息条数', () => {
    const db = openDatabase(':memory:')
    insertConversation(db, conv('晚', { createdAt: 20 }))
    insertConversation(db, conv('早', { createdAt: 10 }))
    insertMessage(db, msg('m1', '早'))
    insertMessage(db, msg('m2', '早', { role: 'assistant' }))
    const got = listConversations(db, '书1')
    expect(got.map((c) => c.id)).toEqual(['早', '晚'])
    expect(got[0].messageCount).toBe(2)
    expect(got[1].messageCount).toBe(0)
    db.close()
  })

  it('只列出指定书的对话', () => {
    const db = openDatabase(':memory:')
    insertConversation(db, conv('本书'))
    insertConversation(db, conv('别的书', { bookId: '书2' }))
    expect(listConversations(db, '书1').map((c) => c.id)).toEqual(['本书'])
    db.close()
  })

  it('合并终点可以写入也可以清空', () => {
    const db = openDatabase(':memory:')
    insertConversation(db, conv('a'))
    updateConversationMerge(db, 'a', 'epubcfi(/6/4!/4/2/20/1:0)')
    expect(getConversation(db, 'a')!.mergedEndCfi).toBe('epubcfi(/6/4!/4/2/20/1:0)')
    updateConversationMerge(db, 'a', null)
    expect(getConversation(db, 'a')!.mergedEndCfi).toBeNull()
    db.close()
  })

  it('消息按时间升序返回,引用句子原样往返', () => {
    const db = openDatabase(':memory:')
    insertConversation(db, conv('a'))
    insertMessage(db, msg('m2', 'a', { createdAt: 20 }))
    insertMessage(db, msg('m1', 'a', {
      createdAt: 10,
      quotes: [{ cfiRange: 'epubcfi(/6/4!/4,/2/1:0,/2/1:5)', text: '他终于明白' }]
    }))
    const got = listMessages(db, 'a')
    expect(got.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(got[0].quotes).toEqual([{ cfiRange: 'epubcfi(/6/4!/4,/2/1:0,/2/1:5)', text: '他终于明白' }])
    expect(got[1].quotes).toEqual([])
    db.close()
  })

  it('批量删除对话会连带删掉它们的消息', () => {
    const db = openDatabase(':memory:')
    insertConversation(db, conv('a'))
    insertConversation(db, conv('b'))
    insertMessage(db, msg('m1', 'a'))
    insertMessage(db, msg('m2', 'b'))
    deleteConversations(db, ['a'])
    expect(listConversations(db, '书1').map((c) => c.id)).toEqual(['b'])
    expect(listMessages(db, 'a')).toEqual([])
    expect(listMessages(db, 'b').map((m) => m.id)).toEqual(['m2'])
    db.close()
  })

  it('批量删除传空数组不报错也不误删', () => {
    const db = openDatabase(':memory:')
    insertConversation(db, conv('a'))
    deleteConversations(db, [])
    expect(countConversations(db, '书1')).toBe(1)
    db.close()
  })

  it('统计条数只算指定的书', () => {
    const db = openDatabase(':memory:')
    insertConversation(db, conv('a'))
    insertConversation(db, conv('b'))
    insertConversation(db, conv('c', { bookId: '书2' }))
    expect(countConversations(db, '书1')).toBe(2)
    db.close()
  })

  it('删掉书时它的对话和消息一并消失', () => {
    const db = openDatabase(':memory:')
    db.prepare(
      `INSERT INTO books (id, title, file_path, source_path, added_at) VALUES (?, ?, ?, ?, ?)`
    ).run('书1', '测试之书', '/x.epub', '/y.epub', 1)
    insertConversation(db, conv('a'))
    insertMessage(db, msg('m1', 'a'))
    db.prepare('DELETE FROM books WHERE id = ?').run('书1')
    expect(countConversations(db, '书1')).toBe(0)
    expect(listMessages(db, 'a')).toEqual([])
    db.close()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx --no-install vitest run tests/unit/db-conversations.test.ts`
Expected: FAIL — 找不到 `src/main/db/conversations`

- [ ] **Step 3: 扩充 schema 并提升版本号**

`src/main/db/index.ts` 的 `SCHEMA` 末尾追加:

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT PRIMARY KEY,
  book_id        TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  start_cfi      TEXT NOT NULL,
  end_cfi        TEXT NOT NULL,
  merged_end_cfi TEXT,
  chapter_label  TEXT,
  excerpt        TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_book ON conversations(book_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  quotes          TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
```

把 `SCHEMA_VERSION` 改成 `2`,并在迁移插槽里填上真正的迁移:

```ts
  } else if (version < SCHEMA_VERSION) {
    if (version < 2) {
      // v1 的库没有 conversations / messages 两张表。上面的 SCHEMA 用的是
      // CREATE TABLE IF NOT EXISTS,已经把它们建好了,这里只需把版本号推上去。
      db.exec('PRAGMA user_version = 2')
    }
  }
```

注意 `PRAGMA foreign_keys = ON` 已经在 `openDatabase` 里打开,上面两条 `ON DELETE CASCADE` 才会真正生效——最后一个测试用例就是验证这一点。

- [ ] **Step 4: 扩充共用类型**

把本任务 Interfaces 里列出的 `ConversationRecord`、`QuoteRecord`、`MessageRecord`、`ConversationWithCount` 四个接口原样追加到 `src/shared/types.ts`。

- [ ] **Step 5: 实现对话与消息读写**

`src/main/db/conversations.ts`:

```ts
import type {
  ConversationRecord,
  ConversationWithCount,
  MessageRecord,
  QuoteRecord
} from '../../shared/types'
import type { Db } from './index'

interface ConvRow {
  id: string
  book_id: string
  start_cfi: string
  end_cfi: string
  merged_end_cfi: string | null
  chapter_label: string | null
  excerpt: string
  created_at: number
}

function toConv(row: ConvRow): ConversationRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    startCfi: row.start_cfi,
    endCfi: row.end_cfi,
    mergedEndCfi: row.merged_end_cfi,
    chapterLabel: row.chapter_label,
    excerpt: row.excerpt,
    createdAt: row.created_at
  }
}

const CONV_COLUMNS =
  'id, book_id, start_cfi, end_cfi, merged_end_cfi, chapter_label, excerpt, created_at'

export function insertConversation(db: Db, c: ConversationRecord): void {
  db.prepare(
    `INSERT INTO conversations (${CONV_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    c.id,
    c.bookId,
    c.startCfi,
    c.endCfi,
    c.mergedEndCfi,
    c.chapterLabel,
    c.excerpt,
    c.createdAt
  )
}

export function getConversation(db: Db, id: string): ConversationRecord | null {
  const row = db
    .prepare(`SELECT ${CONV_COLUMNS} FROM conversations WHERE id = ?`)
    .get(id) as ConvRow | undefined
  return row ? toConv(row) : null
}

export function updateConversationMerge(db: Db, id: string, mergedEndCfi: string | null): void {
  db.prepare('UPDATE conversations SET merged_end_cfi = ? WHERE id = ?').run(mergedEndCfi, id)
}

export function listConversations(db: Db, bookId: string): ConversationWithCount[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.book_id, c.start_cfi, c.end_cfi, c.merged_end_cfi,
              c.chapter_label, c.excerpt, c.created_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
        WHERE c.book_id = ?
        ORDER BY c.created_at ASC`
    )
    .all(bookId) as unknown as (ConvRow & { message_count: number })[]
  return rows.map((row) => ({ ...toConv(row), messageCount: row.message_count }))
}

export function countConversations(db: Db, bookId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE book_id = ?')
    .get(bookId) as { n: number }
  return row.n
}

export function deleteConversations(db: Db, ids: string[]): void {
  if (ids.length === 0) return
  const holes = ids.map(() => '?').join(', ')
  // messages 上的外键带 ON DELETE CASCADE,连带删除由数据库完成
  db.prepare(`DELETE FROM conversations WHERE id IN (${holes})`).run(...ids)
}

interface MsgRow {
  id: string
  conversation_id: string
  role: string
  content: string
  quotes: string
  created_at: number
}

function parseQuotes(raw: string): QuoteRecord[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as QuoteRecord[]) : []
  } catch {
    return []
  }
}

export function insertMessage(db: Db, m: MessageRecord): void {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, quotes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(m.id, m.conversationId, m.role, m.content, JSON.stringify(m.quotes), m.createdAt)
}

export function listMessages(db: Db, conversationId: string): MessageRecord[] {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, role, content, quotes, created_at
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(conversationId) as unknown as MsgRow[]
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    quotes: parseQuotes(row.quotes),
    createdAt: row.created_at
  }))
}
```

- [ ] **Step 6: 扩充迁移测试**

在 `tests/unit/db-index.test.ts` 追加:

```ts
it('v1 的旧库打开后会补齐新表并把版本号推到当前值', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'reader-mig-')), 'old.db')
  // 造一个只有 v1 结构的库
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE books (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, cover_path TEXT,
    file_path TEXT NOT NULL, source_path TEXT NOT NULL DEFAULT '', locations TEXT,
    added_at INTEGER NOT NULL, last_read_cfi TEXT, last_read_at INTEGER)`)
  old.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  old.prepare(
    `INSERT INTO books (id, title, file_path, source_path, added_at) VALUES (?, ?, ?, ?, ?)`
  ).run('保留的书', '旧书', '/a.epub', '/b.epub', 1)
  old.exec('PRAGMA user_version = 1')
  old.close()

  const db = openDatabase(file)
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number
  }
  expect(version).toBe(SCHEMA_VERSION)
  // 原有数据没被破坏
  const row = db.prepare('SELECT title FROM books WHERE id = ?').get('保留的书') as { title: string }
  expect(row.title).toBe('旧书')
  // 新表可用
  expect(() => db.prepare('SELECT COUNT(*) FROM conversations').get()).not.toThrow()
  db.close()
})
```

该文件顶部按需补上 `mkdtempSync`、`tmpdir`、`join`、`DatabaseSync`、`SCHEMA_VERSION` 的 import。

- [ ] **Step 7: 运行全部测试**

Run: `npm test`
Expected: PASS — 计划一的 129 个加本任务新增的全部通过

- [ ] **Step 8: 验证级联删除是真的**

把 `openDatabase` 里的 `PRAGMA foreign_keys = ON` 临时注释掉,重跑 `npx --no-install vitest run tests/unit/db-conversations.test.ts`,确认"删掉书时它的对话和消息一并消失"这条变红,再恢复并确认转绿。把三次输出贴进报告。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat: store conversations and messages"
```

---

### Task 3: API key 加密存取

**Files:**
- Create: `src/main/secrets.ts`
- Test: `tests/unit/secrets.test.ts`

**Interfaces:**
- Consumes: `resolveDataDir()`、Electron 的 `safeStorage`
- Produces:
  - `setApiKey(key: string): void` — 加密后写入数据目录下的 `apikey.bin`;传空串等于清除
  - `getApiKey(): string | null` — 解密取回;没设过或解不开返回 `null`
  - `hasApiKey(): boolean` — 只回答有没有,**不返回内容**
  - `clearApiKey(): void`

**两条硬性设计:**
1. **密钥永不进入渲染进程。** 渲染层只能问"设没设过"(`hasApiKey`),拿不到明文。IPC 里不得存在任何返回密钥内容的通道。
2. **依赖注入 safeStorage。** 模块顶层不 import electron——单元测试跑在纯 Node 下,加载 electron 会失败。改成模块内部惰性取用,并留一个仅测试使用的注入口。

- [ ] **Step 1: 写失败的测试**

`tests/unit/secrets.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __setSafeStorageForTests,
  clearApiKey,
  getApiKey,
  hasApiKey,
  keyFilePath,
  setApiKey
} from '../../src/main/secrets'

/** 假的 safeStorage:用可逆的字节反转冒充加密,足以验证"落盘的不是明文"。 */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(Buffer.from(s, 'utf8').reverse()),
  decryptString: (b: Buffer) => Buffer.from(Buffer.from(b).reverse()).toString('utf8')
}

beforeEach(() => {
  process.env.READER_USER_DATA = mkdtempSync(join(tmpdir(), 'reader-secrets-'))
  __setSafeStorageForTests(fakeSafeStorage)
})

describe('API 密钥存取', () => {
  it('没设过时读出来是 null,hasApiKey 为 false', () => {
    expect(getApiKey()).toBeNull()
    expect(hasApiKey()).toBe(false)
  })

  it('写入后能原样读回', () => {
    setApiKey('sk-测试-1234')
    expect(getApiKey()).toBe('sk-测试-1234')
    expect(hasApiKey()).toBe(true)
  })

  it('落盘的内容不是明文', () => {
    setApiKey('sk-明文不该出现')
    const raw = readFileSync(keyFilePath())
    expect(raw.toString('utf8')).not.toContain('sk-明文不该出现')
  })

  it('重复写入是覆盖', () => {
    setApiKey('旧的')
    setApiKey('新的')
    expect(getApiKey()).toBe('新的')
  })

  it('清除后文件消失,读出来是 null', () => {
    setApiKey('sk-x')
    clearApiKey()
    expect(existsSync(keyFilePath())).toBe(false)
    expect(getApiKey()).toBeNull()
    expect(hasApiKey()).toBe(false)
  })

  it('写入空串等于清除', () => {
    setApiKey('sk-x')
    setApiKey('')
    expect(getApiKey()).toBeNull()
  })

  it('文件损坏时返回 null 而不是抛错', () => {
    setApiKey('sk-x')
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(keyFilePath(), Buffer.from([0, 1, 2]))
    __setSafeStorageForTests({
      ...fakeSafeStorage,
      decryptString: () => {
        throw new Error('解密失败')
      }
    })
    expect(getApiKey()).toBeNull()
  })

  it('系统不支持加密时写入抛出可读的中文错误', () => {
    __setSafeStorageForTests({ ...fakeSafeStorage, isEncryptionAvailable: () => false })
    expect(() => setApiKey('sk-x')).toThrow(/加密/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx --no-install vitest run tests/unit/secrets.test.ts`
Expected: FAIL — 找不到 `src/main/secrets`

- [ ] **Step 3: 实现**

`src/main/secrets.ts`:

```ts
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from './paths'

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

let injected: SafeStorageLike | null = null

/** 仅测试使用:注入一个假的 safeStorage,避免单元测试加载 electron。 */
export function __setSafeStorageForTests(fake: SafeStorageLike | null): void {
  injected = fake
}

function safeStorage(): SafeStorageLike {
  if (injected) return injected
  // 惰性取用:模块顶层不能 import electron,否则纯 Node 下的单元测试加载即失败
  const electron = require('electron') as typeof import('electron')
  return electron.safeStorage
}

export function keyFilePath(): string {
  return join(resolveDataDir(), 'apikey.bin')
}

/**
 * 写入 API 密钥。密钥用操作系统提供的加密能力加密后落盘,数据库文件
 * 被整个拷走也拿不到它。传空串等于清除。
 */
export function setApiKey(key: string): void {
  if (key.length === 0) {
    clearApiKey()
    return
  }
  const storage = safeStorage()
  if (!storage.isEncryptionAvailable()) {
    throw new Error('当前系统不支持安全加密存储,无法保存 API 密钥')
  }
  writeFileSync(keyFilePath(), storage.encryptString(key))
}

/** 取回明文密钥。只在主进程内部调用——这个值不得经由任何 IPC 通道流向渲染进程。 */
export function getApiKey(): string | null {
  const path = keyFilePath()
  if (!existsSync(path)) return null
  try {
    return safeStorage().decryptString(readFileSync(path))
  } catch {
    // 文件损坏、或换了机器导致解不开:当作没设过,让用户重新填
    return null
  }
}

/** 只回答有没有设过,不返回内容——这是渲染层唯一被允许知道的事。 */
export function hasApiKey(): boolean {
  return getApiKey() !== null
}

export function clearApiKey(): void {
  rmSync(keyFilePath(), { force: true })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: store the api key with the system keychain"
```

---

### Task 4: 流式响应解析与错误分类

**Files:**
- Create: `src/main/llm/sse.ts`
- Create: `src/main/llm/errors.ts`
- Test: `tests/unit/llm-sse.test.ts`
- Test: `tests/unit/llm-errors.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `createSseParser(): { push(chunk: string): string[]; done(): void }` — 喂入网络收到的原始片段,吐出解析出的文字增量。片段可能在任意字节处被切断,解析器必须自己缓冲。
  - `classifyHttpError(status: number, body: string): string` — 把 HTTP 状态码和响应体翻译成可读中文
  - `classifyNetworkError(err: unknown): string` — 把 fetch 层抛出的错误翻译成可读中文

**为什么单独成模块:** 流式解析是纯字符串状态机,错误分类是纯映射,都能脱离网络完整测试。设计文档要求六类错误分开说清楚,因为解决办法完全不同——统一显示"出错了"会让开源项目的 issue 被淹没。

- [ ] **Step 1: 写失败的测试**

`tests/unit/llm-sse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createSseParser } from '../../src/main/llm/sse'

function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

describe('流式响应解析', () => {
  it('一个完整事件吐出一段文字', () => {
    const p = createSseParser()
    expect(p.push(chunk('你好'))).toEqual(['你好'])
  })

  it('多个事件挤在同一个网络片段里,按顺序全部吐出', () => {
    const p = createSseParser()
    expect(p.push(chunk('你') + chunk('好'))).toEqual(['你', '好'])
  })

  it('事件被切成两半到达时,先缓冲再吐出', () => {
    const p = createSseParser()
    const whole = chunk('分两次到达')
    const cut = Math.floor(whole.length / 2)
    expect(p.push(whole.slice(0, cut))).toEqual([])
    expect(p.push(whole.slice(cut))).toEqual(['分两次到达'])
  })

  it('结束标记不产生文字', () => {
    const p = createSseParser()
    expect(p.push('data: [DONE]\n\n')).toEqual([])
  })

  it('没有 content 的增量被跳过(例如只带 role 的首帧)', () => {
    const p = createSseParser()
    const only = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`
    expect(p.push(only)).toEqual([])
  })

  it('空行与注释行被忽略', () => {
    const p = createSseParser()
    expect(p.push(`\n: 心跳\n\n${chunk('正文')}`)).toEqual(['正文'])
  })

  it('不是 JSON 的数据行被跳过而不是抛错', () => {
    const p = createSseParser()
    expect(p.push('data: {坏掉的\n\n' + chunk('后面的还要'))).toEqual(['后面的还要'])
  })

  it('内容是空字符串的增量被跳过,不产生空片段', () => {
    const p = createSseParser()
    expect(p.push(chunk(''))).toEqual([])
  })

  it('done() 之后缓冲里的残缺数据被丢弃,不会误吐', () => {
    const p = createSseParser()
    p.push('data: {"choices":[{"delta":{"content":"半截')
    p.done()
    expect(p.push('')).toEqual([])
  })
})
```

`tests/unit/llm-errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classifyHttpError, classifyNetworkError } from '../../src/main/llm/errors'

describe('HTTP 错误分类', () => {
  it('401 说密钥无效', () => {
    expect(classifyHttpError(401, '')).toMatch(/密钥/)
  })

  it('403 说没有权限', () => {
    expect(classifyHttpError(403, '')).toMatch(/权限/)
  })

  it('429 说额度或频率', () => {
    const msg = classifyHttpError(429, '')
    expect(msg).toMatch(/额度|频繁/)
  })

  it('404 说模型名或接口地址填错', () => {
    const msg = classifyHttpError(404, '')
    expect(msg).toMatch(/模型|地址/)
  })

  it('5xx 说是对方服务故障', () => {
    expect(classifyHttpError(503, '')).toMatch(/服务/)
  })

  it('把服务端给的原因附在后面,便于排查', () => {
    const body = JSON.stringify({ error: { message: 'model not found: gtp-4' } })
    expect(classifyHttpError(404, body)).toContain('model not found: gtp-4')
  })

  it('响应体不是 JSON 时不抛错,只给出状态码对应的说法', () => {
    expect(() => classifyHttpError(500, '<html>502 Bad Gateway</html>')).not.toThrow()
    expect(classifyHttpError(500, '<html>')).toMatch(/服务/)
  })

  it('没有单独归类的状态码也给出带状态码的中文说明', () => {
    expect(classifyHttpError(418, '')).toContain('418')
  })
})

describe('网络错误分类', () => {
  it('连不上时说检查地址与代理', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    expect(classifyNetworkError(err)).toMatch(/连不上|地址/)
  })

  it('域名解析失败单独说明', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    expect(classifyNetworkError(err)).toMatch(/地址/)
  })

  it('超时单独说明', () => {
    const err = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    expect(classifyNetworkError(err)).toMatch(/超时/)
  })

  it('用户主动中止不算错误', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(classifyNetworkError(err)).toBe('')
  })

  it('完全不认识的东西也给出中文兜底,不抛错', () => {
    expect(classifyNetworkError('随便一个字符串')).toMatch(/请求失败/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx --no-install vitest run tests/unit/llm-sse.test.ts tests/unit/llm-errors.test.ts`
Expected: FAIL — 两个模块都不存在

- [ ] **Step 3: 实现流式解析**

`src/main/llm/sse.ts`:

```ts
/**
 * OpenAI 兼容接口的流式响应解析器。
 *
 * 网络片段可能在任意字节处被切断——一个事件可能被劈成两半,也可能几个事件
 * 挤在同一个片段里。所以必须自己缓冲,只处理已经收到完整空行分隔的部分。
 */
export function createSseParser(): { push(chunk: string): string[]; done(): void } {
  let buffer = ''
  let finished = false

  function parseEvent(block: string): string | null {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice('data:'.length).trim()
      if (payload === '[DONE]') return null
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[]
        }
        const content = parsed.choices?.[0]?.delta?.content
        if (typeof content === 'string' && content.length > 0) return content
      } catch {
        // 半截或畸形的 JSON:跳过这一行,后面的还要继续
      }
    }
    return null
  }

  return {
    push(chunk: string): string[] {
      if (finished) return []
      buffer += chunk
      const out: string[] = []
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const text = parseEvent(block)
        if (text !== null) out.push(text)
        cut = buffer.indexOf('\n\n')
      }
      return out
    },
    done(): void {
      finished = true
      buffer = ''
    }
  }
}
```

- [ ] **Step 4: 实现错误分类**

`src/main/llm/errors.ts`:

```ts
/** 尽力从服务端响应体里挖出可读的原因,挖不到就返回空串。 */
function serverReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string }
    const reason = parsed.error?.message ?? parsed.message
    return typeof reason === 'string' && reason.length > 0 ? reason : ''
  } catch {
    return ''
  }
}

function withReason(base: string, body: string): string {
  const reason = serverReason(body)
  return reason ? `${base}(服务端说明:${reason})` : base
}

/**
 * 把 HTTP 状态码翻译成用户能据以行动的中文。
 * 分开说是必须的——这六类问题的解决办法完全不同,统一显示"出错了"
 * 会让用户无从下手。
 */
export function classifyHttpError(status: number, body: string): string {
  if (status === 401) return withReason('API 密钥无效,请到设置里检查', body)
  if (status === 403) return withReason('这个密钥没有访问该模型的权限', body)
  if (status === 429) return withReason('额度用尽或请求过于频繁,稍后再试', body)
  if (status === 404) return withReason('模型名或接口地址填错了,请到设置里检查', body)
  if (status >= 500) return withReason('对方服务故障,稍后重试', body)
  return withReason(`请求失败(HTTP ${status})`, body)
}

/** 把 fetch 层抛出的东西翻译成中文。用户主动中止返回空串——那不是错误。 */
export function classifyNetworkError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { name?: string; cause?: { code?: string } }
    if (e.name === 'AbortError') return ''
    if (e.name === 'TimeoutError') return '请求超时,对方一直没有回应'
    const code = e.cause?.code
    if (code === 'ECONNREFUSED') return '连不上服务器,请检查接口地址与代理设置'
    if (code === 'ENOTFOUND') return '接口地址解析不到,请检查是否填错'
    if (code === 'ETIMEDOUT') return '请求超时,对方一直没有回应'
  }
  return '请求失败,请检查网络与接口地址'
}
```

- [ ] **Step 5: 运行全部测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 验证缓冲逻辑是真的**

把 `push` 里的 `buffer += chunk` 改成 `buffer = chunk`(即不缓冲),重跑 `npx --no-install vitest run tests/unit/llm-sse.test.ts`,确认"事件被切成两半"那条变红,再恢复并确认转绿。把三次输出贴进报告。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: parse streaming responses and classify request failures"
```

---

### Task 5: 上下文拼装与四级裁剪

**Files:**
- Create: `src/renderer/chat/tokens.ts`
- Create: `src/renderer/chat/context.ts`
- Test: `tests/unit/tokens.test.ts`
- Test: `tests/unit/context.test.ts`

**Interfaces:**
- Consumes: `VisibleRange`、`TocItem`、`QuoteRecord`
- Produces:

```ts
// tokens.ts
export function estimateTokens(text: string): number

// context.ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ContextInput {
  systemPrompt: string
  bookTitle: string
  author: string | null
  visible: VisibleRange
  toc: TocItem[]
  quotes: QuoteRecord[]
  history: ChatMessage[]      // 当前对话里已有的问答,按时间升序
  userText: string
  limit: number               // token 上限,默认 8000
}

export interface ContextResult {
  messages: ChatMessage[]
  /** 实际执行了哪些降级动作,供界面提示与测试断言 */
  trimmed: ('toc-local' | 'drop-history' | 'toc-dropped')[]
}

export function buildContext(input: ContextInput): ContextResult
```

**这是整个产品的核心逻辑。** 它不碰界面也不碰网络,纯数据进纯数据出。出错的表现是"AI 答得莫名其妙",肉眼极难发现——所以测试要覆盖到每一条降级与裁剪规则。

**必须实现的规则(逐条来自设计文档 §6.2):**
- **永不丢弃**:系统提示词、书名、作者、当前章节名、当前页正文、本轮引用句子。
- **降级策略**:基础层是书名 + 作者 + 当前页正文;增强层是全书目录 + 当前章节名,**两者必须同时可得才一起加入**;只能拿到其中一项时两项都不加。
- **裁剪顺序**,依次执行直到装得下:① 目录裁成局部(当前章节前后各 5 条)② 删除最早的一轮问答(一问一答成对删除)③ 目录整个丢弃 ④ 仍然超限则抛错 `当前页文字量超出模型上下文上限`,**不静默截断正文**。
- **近似标记**:`visible.approximate` 为 true 时,正文段的标题必须写成「当前章节全文(可见范围跨章,这不是精确的一屏内容)」,不得写成「当前页内容」。

- [ ] **Step 1: 写长度估算的失败测试**

`tests/unit/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../../src/renderer/chat/tokens'

describe('长度估算', () => {
  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('中文按每字一个计', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('英文按每四个字符一个计,向上取整', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('中英混排分别计算后相加', () => {
    expect(estimateTokens('你好abcd')).toBe(3)
  })

  it('估算值随文本变长而单调不减', () => {
    const short = estimateTokens('他终于明白')
    const long = estimateTokens('他终于明白过来,原来那天')
    expect(long).toBeGreaterThan(short)
  })
})
```

- [ ] **Step 2: 运行确认失败,然后实现**

Run: `npx --no-install vitest run tests/unit/tokens.test.ts`
Expected: FAIL — 模块不存在

`src/renderer/chat/tokens.ts`:

```ts
/**
 * 估算一段文字占多少 token。
 *
 * 这是估算不是精确计数:精确计数要为每个厂商装配不同的分词器,对一个
 * 本地阅读器不值得。中日韩文字按每字一个 token 计,其余字符按每四个一个计,
 * 都是各家分词器的常见量级。估算偏保守,真超限了由接口报错兜底,
 * 走错误分类那条路。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x3040 && code <= 0x30ff) || // 日文假名
      (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
      (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
      (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
      (code >= 0xac00 && code <= 0xd7af) // 谚文
    if (isCjk) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}
```

Run: `npx --no-install vitest run tests/unit/tokens.test.ts`
Expected: PASS

- [ ] **Step 3: 写上下文拼装的失败测试**

`tests/unit/context.test.ts`:

```ts
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

  it('第三步把目录整个丢掉', () => {
    const r = buildContext(input({ toc: toc(200), limit: 120 }))
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
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npx --no-install vitest run tests/unit/context.test.ts`
Expected: FAIL — 找不到 `src/renderer/chat/context`

- [ ] **Step 5: 实现**

`src/renderer/chat/context.ts`:

```ts
import type { QuoteRecord } from '@shared/types'
import type { TocItem, VisibleRange } from '../reader/types'
import { estimateTokens } from './tokens'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ContextInput {
  systemPrompt: string
  bookTitle: string
  author: string | null
  visible: VisibleRange
  toc: TocItem[]
  quotes: QuoteRecord[]
  history: ChatMessage[]
  userText: string
  limit: number
}

export type TrimAction = 'toc-local' | 'drop-history' | 'toc-dropped'

export interface ContextResult {
  messages: ChatMessage[]
  trimmed: TrimAction[]
}

/** 目录裁成局部时,当前章节前后各保留几条 */
const TOC_NEIGHBOURS = 5

function tocLines(items: TocItem[]): string {
  return items.map((t) => `${'  '.repeat(t.depth)}- ${t.label}`).join('\n')
}

function localToc(items: TocItem[], chapterHref: string): TocItem[] {
  const bare = (h: string): string => h.split('#')[0]
  const at = items.findIndex((t) => bare(t.href) === bare(chapterHref))
  if (at < 0) return items.slice(0, TOC_NEIGHBOURS * 2 + 1)
  return items.slice(Math.max(0, at - TOC_NEIGHBOURS), at + TOC_NEIGHBOURS + 1)
}

function buildSystem(
  input: ContextInput,
  toc: TocItem[] | null,
  useEnhanced: boolean
): string {
  const parts: string[] = [input.systemPrompt, '', `当前阅读的书:《${input.bookTitle}》`]
  if (input.author) parts.push(`作者:${input.author}`)

  // 增强层:目录与当前章节名必须同时可得才一起加入,缺一个就都不加。
  if (useEnhanced && input.visible.chapterLabel) {
    parts.push(`当前章节:${input.visible.chapterLabel}`)
    if (toc && toc.length > 0) {
      parts.push('', '全书目录:', tocLines(toc))
    }
  }

  // approximate 为 true 时 text 是整份章节文档的全文,不是一屏可见内容。
  // 标题必须如实说明,否则模型会把整章当成用户眼前看到的那一小段。
  const heading = input.visible.approximate
    ? '当前章节全文(可见范围跨章,这不是精确的一屏内容):'
    : '当前页内容:'
  parts.push('', heading, input.visible.text)
  return parts.join('\n')
}

function buildUser(input: ContextInput): string {
  if (input.quotes.length === 0) return input.userText
  const quoted = input.quotes.map((q) => `> ${q.text}`).join('\n')
  return `用户划选的原文:\n${quoted}\n\n${input.userText}`
}

function total(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}

/**
 * 按降级策略拼上下文,超限时按固定顺序裁剪。
 *
 * 永不丢弃:系统提示词、书名、作者、当前章节名、当前页正文、本轮引用句子。
 * 裁剪顺序:目录裁成局部 → 删最早的一轮问答 → 目录整个丢掉 → 仍超限则抛错。
 * 最后一步是抛错而不是截断正文:静默截断会让模型看到半句话却毫无察觉,
 * 产生的错误答案从外面看不出任何异常。
 */
export function buildContext(input: ContextInput): ContextResult {
  const trimmed: TrimAction[] = []
  const userMessage: ChatMessage = { role: 'user', content: buildUser(input) }

  // 增强层的前提:目录和章节名同时可得
  const enhanced = input.toc.length > 0 && input.visible.chapterLabel !== null
  let toc: TocItem[] | null = enhanced ? input.toc : null
  let history = [...input.history]

  const assemble = (): ChatMessage[] => [
    { role: 'system', content: buildSystem(input, toc, enhanced) },
    ...history,
    userMessage
  ]

  let messages = assemble()
  if (total(messages) <= input.limit) return { messages, trimmed }

  // ① 目录裁成当前章节前后各 5 条
  if (toc && toc.length > TOC_NEIGHBOURS * 2 + 1) {
    toc = localToc(toc, input.visible.chapterHref)
    trimmed.push('toc-local')
    messages = assemble()
    if (total(messages) <= input.limit) return { messages, trimmed }
  }

  // ② 一问一答成对删除最早的一轮
  while (history.length >= 2) {
    history = history.slice(2)
    if (!trimmed.includes('drop-history')) trimmed.push('drop-history')
    messages = assemble()
    if (total(messages) <= input.limit) return { messages, trimmed }
  }

  // ③ 目录整个丢掉
  if (toc !== null) {
    toc = null
    trimmed.push('toc-dropped')
    messages = assemble()
    if (total(messages) <= input.limit) return { messages, trimmed }
  }

  // ④ 不截断正文,直接告诉用户
  throw new Error('当前页文字量超出模型上下文上限,请调小字号后重试,或在设置里换一个上下文更大的模型')
}
```

**注意**:`@shared/*` 别名在渲染层可用(见 `electron.vite.config.ts`),但 vitest 的配置里也必须能解析它——`vitest.config.ts` 已经配了这个别名,确认一下即可。

- [ ] **Step 6: 运行全部测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: 验证降级与裁剪是真的**

做两次变异验证,每次都要看到指定用例变红再恢复:
1. 把增强层条件 `input.toc.length > 0 && input.visible.chapterLabel !== null` 改成 `true`,确认"目录为空时章节名也不加入"变红。
2. 把 ④ 的 `throw` 换成截断正文后返回,确认"全裁完仍然超限时抛出中文错误"变红。

把每次的三段输出贴进报告。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat: assemble chat context with degradation and trimming rules"
```

---

### Task 6: 流式请求客户端

**Files:**
- Create: `src/main/llm/client.ts`
- Test: `tests/unit/llm-client.test.ts`

**Interfaces:**
- Consumes: `createSseParser`、`classifyHttpError`、`classifyNetworkError`、`getApiKey`
- Produces:

```ts
export interface StreamOptions {
  endpoint: string
  model: string
  apiKey: string
  messages: { role: string; content: string }[]
  signal: AbortSignal
  onChunk: (text: string) => void
  /** 仅测试注入;缺省用全局 fetch */
  fetchImpl?: typeof fetch
}

/** 成功时 resolve;失败时 reject 一个 message 已经是中文的 Error。用户中止时正常 resolve。 */
export function streamChat(options: StreamOptions): Promise<void>
```

- [ ] **Step 1: 写失败的测试**

`tests/unit/llm-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { streamChat } from '../../src/main/llm/client'

function sseResponse(texts: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const t of texts) {
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
        )
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  return new Response(body, { status })
}

function base(over: Partial<Parameters<typeof streamChat>[0]> = {}) {
  return {
    endpoint: 'https://example.invalid/v1',
    model: 'test-model',
    apiKey: 'sk-test',
    messages: [{ role: 'user', content: '你好' }],
    signal: new AbortController().signal,
    onChunk: () => {},
    ...over
  }
}

describe('流式请求', () => {
  it('把收到的文字块按顺序交给回调', async () => {
    const got: string[] = []
    await streamChat(
      base({
        onChunk: (t) => got.push(t),
        fetchImpl: async () => sseResponse(['你', '好', '吗'])
      })
    )
    expect(got).toEqual(['你', '好', '吗'])
  })

  it('请求发到 endpoint 下的 chat/completions,带上 Bearer 密钥和模型名', async () => {
    const spy = vi.fn(async () => sseResponse(['x']))
    await streamChat(base({ fetchImpl: spy as unknown as typeof fetch }))
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.invalid/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const sent = JSON.parse(init.body as string) as { model: string; stream: boolean }
    expect(sent.model).toBe('test-model')
    expect(sent.stream).toBe(true)
  })

  it('endpoint 末尾有没有斜杠都不影响拼出的地址', async () => {
    const spy = vi.fn(async () => sseResponse(['x']))
    await streamChat(
      base({ endpoint: 'https://example.invalid/v1/', fetchImpl: spy as unknown as typeof fetch })
    )
    expect((spy.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://example.invalid/v1/chat/completions'
    )
  })

  it('密钥不出现在抛出的错误信息里', async () => {
    const fetchImpl = async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })
    await expect(streamChat(base({ fetchImpl: fetchImpl as unknown as typeof fetch })))
      .rejects.toThrow(/密钥/)
    await streamChat(base({ fetchImpl: fetchImpl as unknown as typeof fetch })).catch((e: Error) => {
      expect(e.message).not.toContain('sk-test')
    })
  })

  it('HTTP 错误被翻译成中文抛出', async () => {
    await expect(
      streamChat(
        base({
          fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch
        })
      )
    ).rejects.toThrow(/额度|频繁/)
  })

  it('网络层抛错也被翻译成中文', async () => {
    const boom = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    await expect(
      streamChat(
        base({
          fetchImpl: (async () => {
            throw boom
          }) as unknown as typeof fetch
        })
      )
    ).rejects.toThrow(/连不上|地址/)
  })

  it('用户中止时正常结束,不抛错', async () => {
    const ac = new AbortController()
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    ac.abort()
    await expect(
      streamChat(
        base({
          signal: ac.signal,
          fetchImpl: (async () => {
            throw err
          }) as unknown as typeof fetch
        })
      )
    ).resolves.toBeUndefined()
  })

  it('中止后不再继续交付文字块', async () => {
    const ac = new AbortController()
    const got: string[] = []
    const fetchImpl = async (): Promise<Response> => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '第一块' } }] })}\n\n`)
          )
          ac.abort()
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '第二块' } }] })}\n\n`)
          )
          controller.close()
        }
      })
      return new Response(body, { status: 200 })
    }
    await streamChat(
      base({
        signal: ac.signal,
        onChunk: (t) => got.push(t),
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    )
    expect(got).not.toContain('第二块')
  })

  it('响应没有 body 时报出中文错误', async () => {
    await expect(
      streamChat(
        base({
          fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch
        })
      )
    ).rejects.toThrow(/没有返回/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx --no-install vitest run tests/unit/llm-client.test.ts`
Expected: FAIL — 找不到 `src/main/llm/client`

- [ ] **Step 3: 实现**

`src/main/llm/client.ts`:

```ts
import { classifyHttpError, classifyNetworkError } from './errors'
import { createSseParser } from './sse'

export interface StreamOptions {
  endpoint: string
  model: string
  apiKey: string
  messages: { role: string; content: string }[]
  signal: AbortSignal
  onChunk: (text: string) => void
  fetchImpl?: typeof fetch
}

function chatUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/chat/completions`
}

/**
 * 向 OpenAI 兼容接口发起流式请求。
 *
 * 抛出的 Error 的 message 一律已经是可读中文——界面直接显示即可,不需要
 * 再做二次翻译。密钥只在这里进入请求头,绝不会出现在任何错误信息里。
 * 用户主动中止不算失败,正常 resolve,已经收到的文字块保留。
 */
export async function streamChat(options: StreamOptions): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch
  const parser = createSseParser()

  let response: Response
  try {
    response = await doFetch(chatUrl(options.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: true
      }),
      signal: options.signal
    })
  } catch (err) {
    const message = classifyNetworkError(err)
    if (message === '') return // 用户中止
    throw new Error(message)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(classifyHttpError(response.status, body))
  }

  if (!response.body) {
    throw new Error('对方没有返回任何内容')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      if (options.signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      if (options.signal.aborted) break
      for (const text of parser.push(decoder.decode(value, { stream: true }))) {
        if (options.signal.aborted) break
        options.onChunk(text)
      }
    }
  } catch (err) {
    const message = classifyNetworkError(err)
    if (message !== '') throw new Error(message)
  } finally {
    parser.done()
    await reader.cancel().catch(() => {})
  }
}
```

- [ ] **Step 4: 运行全部测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 验证密钥不外泄**

在 `src/main/llm/client.ts` 里临时把 `throw new Error(classifyHttpError(...))` 改成把整个请求头也拼进错误信息,重跑该测试文件,确认"密钥不出现在抛出的错误信息里"变红,再恢复并确认转绿。把三次输出贴进报告。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: stream chat completions from an openai-compatible endpoint"
```

---

### Task 7: 对话、密钥与模型调用的 IPC 通道

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types.ts`
- Create: `src/main/llm/session.ts`
- Test: `tests/unit/llm-session.test.ts`

**Interfaces:**
- Consumes: Task 2–6 的全部模块
- Produces:新增 preload 方法

```ts
listConversations(bookId: string): Promise<ConversationWithCount[]>
createConversation(input: CreateConversationInput): Promise<ConversationRecord>
setConversationMerge(id: string, mergedEndCfi: string | null): Promise<void>
deleteConversations(ids: string[]): Promise<void>
listMessages(conversationId: string): Promise<MessageRecord[]>
appendMessage(input: AppendMessageInput): Promise<MessageRecord>
hasApiKey(): Promise<boolean>
setApiKey(key: string): Promise<void>
clearApiKey(): Promise<void>
startChat(input: StartChatInput): Promise<string>       // 返回本次请求的 id
abortChat(requestId: string): Promise<void>
onChatChunk(cb: (requestId: string, text: string) => void): () => void
onChatDone(cb: (requestId: string, error: string | null) => void): () => void
```

```ts
// src/shared/types.ts 追加
export interface CreateConversationInput {
  bookId: string
  startCfi: string
  endCfi: string
  chapterLabel: string | null
  excerpt: string
}
export interface AppendMessageInput {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  quotes: QuoteRecord[]
}
export interface StartChatInput {
  messages: { role: string; content: string }[]
}
```

**两条必须守住的边界:**
1. **没有任何通道返回密钥内容。** `hasApiKey` 只回答有没有。
2. **id 由主进程生成。** 对话 id、消息 id、请求 id 一律 `randomUUID()`,不采信渲染层传入的 id——这与计划一里"库内路径由主进程按 id 派生"是同一条原则。

- [ ] **Step 1: 写会话管理器的失败测试**

`src/main/llm/session.ts` 管理"同时在跑的请求",是唯一值得单测的部分(IPC 本身需要 electron,留给端到端)。

`tests/unit/llm-session.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createSessionRegistry } from '../../src/main/llm/session'

describe('请求会话登记', () => {
  it('开始一个请求会拿到唯一 id', () => {
    const reg = createSessionRegistry()
    const a = reg.start()
    const b = reg.start()
    expect(a.id).not.toBe(b.id)
  })

  it('新开的请求没有被中止', () => {
    const reg = createSessionRegistry()
    expect(reg.start().signal.aborted).toBe(false)
  })

  it('按 id 中止会让对应的信号变为已中止', () => {
    const reg = createSessionRegistry()
    const s = reg.start()
    reg.abort(s.id)
    expect(s.signal.aborted).toBe(true)
  })

  it('中止一个请求不影响另一个', () => {
    const reg = createSessionRegistry()
    const a = reg.start()
    const b = reg.start()
    reg.abort(a.id)
    expect(b.signal.aborted).toBe(false)
  })

  it('中止不存在的 id 不报错', () => {
    const reg = createSessionRegistry()
    expect(() => reg.abort('没有这个')).not.toThrow()
  })

  it('结束后再中止同一个 id 不报错', () => {
    const reg = createSessionRegistry()
    const s = reg.start()
    reg.finish(s.id)
    expect(() => reg.abort(s.id)).not.toThrow()
  })

  it('结束会把请求从登记表里移除', () => {
    const reg = createSessionRegistry()
    const s = reg.start()
    expect(reg.size()).toBe(1)
    reg.finish(s.id)
    expect(reg.size()).toBe(0)
  })

  it('abortAll 中止全部并清空登记表', () => {
    const reg = createSessionRegistry()
    const a = reg.start()
    const b = reg.start()
    reg.abortAll()
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(reg.size()).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败,然后实现**

Run: `npx --no-install vitest run tests/unit/llm-session.test.ts`
Expected: FAIL — 模块不存在

`src/main/llm/session.ts`:

```ts
import { randomUUID } from 'node:crypto'

export interface ChatSession {
  id: string
  signal: AbortSignal
}

/**
 * 登记同时在跑的模型请求,让渲染层能按 id 中止其中某一个。
 * id 在这里生成而不是由渲染层传入——与"库内路径由主进程派生"同一条原则。
 */
export function createSessionRegistry(): {
  start(): ChatSession
  abort(id: string): void
  abortAll(): void
  finish(id: string): void
  size(): number
} {
  const live = new Map<string, AbortController>()

  return {
    start(): ChatSession {
      const id = randomUUID()
      const controller = new AbortController()
      live.set(id, controller)
      return { id, signal: controller.signal }
    },
    abort(id: string): void {
      live.get(id)?.abort()
      live.delete(id)
    },
    abortAll(): void {
      for (const controller of live.values()) controller.abort()
      live.clear()
    },
    finish(id: string): void {
      live.delete(id)
    },
    size(): number {
      return live.size
    }
  }
}
```

Run: `npx --no-install vitest run tests/unit/llm-session.test.ts`
Expected: PASS

- [ ] **Step 3: 扩充共用类型**

把本任务 Interfaces 里的 `CreateConversationInput`、`AppendMessageInput`、`StartChatInput` 追加到 `src/shared/types.ts`。

- [ ] **Step 4: 注册对话与密钥通道**

在 `src/main/ipc.ts` 的 `registerIpc()` 里追加(顶部按需补 import):

```ts
  ipcMain.handle('chat:listConversations', (_e, bookId: string) =>
    listConversations(database(), bookId)
  )

  ipcMain.handle(
    'chat:createConversation',
    (_e, input: CreateConversationInput): ConversationRecord => {
      // id 由主进程生成,不采信渲染层
      const record: ConversationRecord = {
        id: randomUUID(),
        bookId: input.bookId,
        startCfi: input.startCfi,
        endCfi: input.endCfi,
        mergedEndCfi: null,
        chapterLabel: input.chapterLabel,
        excerpt: input.excerpt.slice(0, 20),
        createdAt: Date.now()
      }
      insertConversation(database(), record)
      return record
    }
  )

  ipcMain.handle('chat:setConversationMerge', (_e, id: string, mergedEndCfi: string | null) => {
    updateConversationMerge(database(), id, mergedEndCfi)
  })

  ipcMain.handle('chat:deleteConversations', (_e, ids: string[]) => {
    deleteConversations(database(), ids)
  })

  ipcMain.handle('chat:listMessages', (_e, conversationId: string) =>
    listMessages(database(), conversationId)
  )

  ipcMain.handle('chat:appendMessage', (_e, input: AppendMessageInput): MessageRecord => {
    const record: MessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      quotes: input.quotes,
      createdAt: Date.now()
    }
    insertMessage(database(), record)
    return record
  })

  // 只回答有没有设过。任何返回密钥内容的通道都是违规的。
  ipcMain.handle('secrets:hasApiKey', () => hasApiKey())
  ipcMain.handle('secrets:setApiKey', (_e, key: string) => setApiKey(key))
  ipcMain.handle('secrets:clearApiKey', () => clearApiKey())
```

- [ ] **Step 5: 注册流式调用通道**

在同一个函数里追加:

```ts
  const sessions = createSessionRegistry()

  ipcMain.handle('chat:start', async (event, input: StartChatInput): Promise<string> => {
    const db = database()
    const endpoint = getSetting(db, 'llmEndpoint') ?? ''
    const model = getSetting(db, 'llmModel') ?? ''
    const apiKey = getApiKey()

    if (!endpoint || !model) throw new Error('还没有配置接口地址和模型名,请先到设置里填写')
    if (!apiKey) throw new Error('还没有填写 API 密钥,请先到设置里填写')

    const session = sessions.start()
    const send = (channel: string, ...args: unknown[]): void => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, ...args)
    }

    // 立刻把 id 还给渲染层,流式内容随后通过事件推过去
    void streamChat({
      endpoint,
      model,
      apiKey,
      messages: input.messages,
      signal: session.signal,
      onChunk: (text) => send('chat:chunk', session.id, text)
    })
      .then(() => send('chat:done', session.id, null))
      .catch((err: unknown) => {
        send('chat:done', session.id, err instanceof Error ? err.message : '请求失败')
      })
      .finally(() => sessions.finish(session.id))

    return session.id
  })

  ipcMain.handle('chat:abort', (_e, requestId: string) => {
    sessions.abort(requestId)
  })
```

在 `src/main/index.ts` 里,窗口关闭时中止所有在跑的请求——把 registry 从 `registerIpc` 里导出一个 `abortAllChats()` 供其调用,或在 `app.on('window-all-closed')` 之前挂 `before-quit` 处理。实现时选一种并在报告里说明。

- [ ] **Step 6: 扩充 preload**

在 `src/preload/index.ts` 的 `api` 对象里追加(事件订阅要返回取消函数,且不得把 `event` 对象透给渲染层):

```ts
  listConversations: (bookId: string): Promise<ConversationWithCount[]> =>
    ipcRenderer.invoke('chat:listConversations', bookId),
  createConversation: (input: CreateConversationInput): Promise<ConversationRecord> =>
    ipcRenderer.invoke('chat:createConversation', input),
  setConversationMerge: (id: string, mergedEndCfi: string | null): Promise<void> =>
    ipcRenderer.invoke('chat:setConversationMerge', id, mergedEndCfi),
  deleteConversations: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('chat:deleteConversations', ids),
  listMessages: (conversationId: string): Promise<MessageRecord[]> =>
    ipcRenderer.invoke('chat:listMessages', conversationId),
  appendMessage: (input: AppendMessageInput): Promise<MessageRecord> =>
    ipcRenderer.invoke('chat:appendMessage', input),

  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke('secrets:hasApiKey'),
  setApiKey: (key: string): Promise<void> => ipcRenderer.invoke('secrets:setApiKey', key),
  clearApiKey: (): Promise<void> => ipcRenderer.invoke('secrets:clearApiKey'),

  startChat: (input: StartChatInput): Promise<string> => ipcRenderer.invoke('chat:start', input),
  abortChat: (requestId: string): Promise<void> => ipcRenderer.invoke('chat:abort', requestId),
  onChatChunk: (cb: (requestId: string, text: string) => void): (() => void) => {
    const handler = (_e: unknown, requestId: string, text: string): void => cb(requestId, text)
    ipcRenderer.on('chat:chunk', handler)
    return () => ipcRenderer.off('chat:chunk', handler)
  },
  onChatDone: (cb: (requestId: string, error: string | null) => void): (() => void) => {
    const handler = (_e: unknown, requestId: string, error: string | null): void =>
      cb(requestId, error)
    ipcRenderer.on('chat:done', handler)
    return () => ipcRenderer.off('chat:done', handler)
  },
```

- [ ] **Step 7: 构建与测试**

Run: `npm run build && npm test`
Expected: 构建通过,全部单元测试通过

- [ ] **Step 8: 确认没有密钥外泄通道**

Run: `grep -rn "getApiKey" src/preload src/renderer || echo "OK:渲染层与 preload 都没有取密钥的调用"`
Expected: 输出 OK。把结果贴进报告。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat: expose conversation, secret and streaming channels over ipc"
```

---

### Task 8: 划选高亮

**Files:**
- Modify: `src/renderer/reader/engine.ts`
- Modify: `src/renderer/reader/types.ts`
- Create: `src/renderer/reader/selection.ts`
- Test: `tests/unit/selection.test.ts`

**Interfaces:**
- Consumes: `ReaderEngine`
- Produces:
  - `types.ts` 的 `ReaderEngine` 新增:
    ```ts
    /** 用户在书内容里完成一次拖选。返回取消订阅函数。 */
    onSelected(cb: (cfiRange: string, text: string) => void): () => void
    /** 给一段范围加高亮;点击该高亮时调用 onClick。 */
    addHighlight(cfiRange: string, onClick: () => void): void
    removeHighlight(cfiRange: string): void
    clearHighlights(): void
    ```
  - `selection.ts`:
    ```ts
    export function createSelectionStore(engine: ReaderEngine): {
      subscribe(cb: (quotes: QuoteRecord[]) => void): () => void
      list(): QuoteRecord[]
      toggle(cfiRange: string, text: string): void
      clear(): void
      dispose(): void
    }
    ```
    **复用 `@shared/types` 里的 `QuoteRecord`,不要另外定义一个同形状的 `Quote`。** 划选出来的句子会原样存进 `messages.quotes`,两边必须是同一个类型,否则改一处忘一处就会静默错位。

**交互规则(来自设计文档 §5):** 拖选松开即高亮,不需要点任何确认按钮;点击已高亮的句子取消高亮;多句可同时高亮;发送消息后页面高亮全部清除;高亮是纯临时标记,不存盘,关书即消失。

**epub.js 的对应能力:** `rendition.on('selected', (cfiRange, contents) => ...)`、`rendition.annotations.highlight(cfiRange, {}, onClick)`、`rendition.annotations.remove(cfiRange, 'highlight')`。实现前先读 `node_modules/epubjs` 确认这一版的真实签名,在报告里写明你看到的。

- [ ] **Step 1: 写 selection store 的失败测试**

store 是纯状态管理,用一个假引擎就能完整测试。

`tests/unit/selection.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createSelectionStore } from '../../src/renderer/reader/selection'
import type { ReaderEngine } from '../../src/renderer/reader/types'

function fakeEngine() {
  const highlights = new Map<string, () => void>()
  let selectedCb: ((cfiRange: string, text: string) => void) | null = null
  const engine = {
    onSelected: (cb: (cfiRange: string, text: string) => void) => {
      selectedCb = cb
      return () => {
        selectedCb = null
      }
    },
    addHighlight: (cfiRange: string, onClick: () => void) => highlights.set(cfiRange, onClick),
    removeHighlight: (cfiRange: string) => void highlights.delete(cfiRange),
    clearHighlights: () => highlights.clear()
  } as unknown as ReaderEngine
  return {
    engine,
    highlights,
    select: (cfiRange: string, text: string) => selectedCb?.(cfiRange, text),
    clickHighlight: (cfiRange: string) => highlights.get(cfiRange)?.(),
    hasSubscriber: () => selectedCb !== null
  }
}

describe('划选引用', () => {
  it('刚创建时没有任何引用', () => {
    const f = fakeEngine()
    expect(createSelectionStore(f.engine).list()).toEqual([])
  })

  it('拖选一句话后它进入引用列表并被高亮', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '他终于明白')
    expect(store.list()).toEqual([{ cfiRange: 'cfi-1', text: '他终于明白' }])
    expect(f.highlights.has('cfi-1')).toBe(true)
  })

  it('多句可以同时选中,按选中顺序排列', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '第一句')
    f.select('cfi-2', '第二句')
    expect(store.list().map((q) => q.text)).toEqual(['第一句', '第二句'])
  })

  it('点击已高亮的句子取消它', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '他终于明白')
    f.clickHighlight('cfi-1')
    expect(store.list()).toEqual([])
    expect(f.highlights.has('cfi-1')).toBe(false)
  })

  it('重复选中同一段是取消而不是加两次', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '他终于明白')
    f.select('cfi-1', '他终于明白')
    expect(store.list()).toEqual([])
  })

  it('clear 清空列表并抹掉页面上所有高亮', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '第一句')
    f.select('cfi-2', '第二句')
    store.clear()
    expect(store.list()).toEqual([])
    expect(f.highlights.size).toBe(0)
  })

  it('订阅者在每次变化时收到最新列表', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    const seen: number[] = []
    store.subscribe((q) => seen.push(q.length))
    f.select('cfi-1', 'a')
    f.select('cfi-2', 'b')
    store.clear()
    expect(seen).toEqual([1, 2, 0])
  })

  it('取消订阅后不再收到通知', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    const cb = vi.fn()
    const off = store.subscribe(cb)
    off()
    f.select('cfi-1', 'a')
    expect(cb).not.toHaveBeenCalled()
  })

  it('dispose 会退订引擎,之后的拖选不再进入列表', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    store.dispose()
    expect(f.hasSubscriber()).toBe(false)
  })

  it('选中空白文本被忽略', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '   ')
    expect(store.list()).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx --no-install vitest run tests/unit/selection.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 selection store**

`src/renderer/reader/selection.ts`:

```ts
import type { QuoteRecord } from '@shared/types'
import type { ReaderEngine } from './types'

/**
 * 管理"这几句要发给 AI"的临时标记。
 *
 * 规则:拖选松开即高亮进列表,点击已高亮的句子取消,重复选中同一段等于取消。
 * 这些高亮不存盘、关书即消失——它不是笔记功能,只是一次提问的附件。
 */
export function createSelectionStore(engine: ReaderEngine): {
  subscribe(cb: (quotes: QuoteRecord[]) => void): () => void
  list(): QuoteRecord[]
  toggle(cfiRange: string, text: string): void
  clear(): void
  dispose(): void
} {
  let quotes: QuoteRecord[] = []
  let listeners: ((q: QuoteRecord[]) => void)[] = []

  function notify(): void {
    const snapshot = [...quotes]
    for (const cb of listeners) cb(snapshot)
  }

  function toggle(cfiRange: string, text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const at = quotes.findIndex((q) => q.cfiRange === cfiRange)
    if (at >= 0) {
      quotes = quotes.filter((q) => q.cfiRange !== cfiRange)
      engine.removeHighlight(cfiRange)
    } else {
      quotes = [...quotes, { cfiRange, text: trimmed }]
      engine.addHighlight(cfiRange, () => toggle(cfiRange, trimmed))
    }
    notify()
  }

  const offSelected = engine.onSelected(toggle)

  return {
    subscribe(cb): () => void {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((x) => x !== cb)
      }
    },
    list: () => [...quotes],
    toggle,
    clear(): void {
      quotes = []
      engine.clearHighlights()
      notify()
    },
    dispose(): void {
      offSelected()
      listeners = []
      quotes = []
    }
  }
}
```

- [ ] **Step 4: 在引擎里实现划选与高亮**

先读 `node_modules/epubjs` 确认 `selected` 事件与 `annotations` 的真实签名,再在 `engine.ts` 里实现四个新方法。要点:

- `rendition.on('selected', (cfiRange, contents) => ...)` 拿到范围后,用 `contents.window.getSelection()?.toString()` 取文字;取完清掉浏览器自身的选区,避免蓝色选中块和自定义高亮叠在一起。
- 高亮用 `rendition.annotations.highlight(cfiRange, {}, onClick)`,取消用 `rendition.annotations.remove(cfiRange, 'highlight')`。
- `clearHighlights()` 要遍历自己记下的范围逐个移除——不要依赖 epub.js 内部结构。engine 内部维护一个 `Set<string>`。
- 这些订阅与标记必须在 `teardown()` 里清干净,并遵守文件里已有的 `generation`/`epoch` 机制:被取代的 `open()` 不得再注册监听。
- 高亮的配色要区分浅色与深色主题,写在 `engine.ts` 已有的主题定义附近。

在 `types.ts` 的 `ReaderEngine` 里加上这四个方法的声明与中文注释。

- [ ] **Step 5: 运行全部测试并构建**

Run: `npm run build && npm test`
Expected: 构建通过,全部单元测试通过(含计划一的 129 个)

- [ ] **Step 6: 验证取消逻辑是真的**

把 `toggle` 里 `at >= 0` 的分支改成总是走"加入",重跑 `npx --no-install vitest run tests/unit/selection.test.ts`,确认"点击已高亮的句子取消它"和"重复选中同一段是取消"两条变红,再恢复并确认转绿。把三次输出贴进报告。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: highlight selected sentences as chat quotes"
```

---

### Task 9: Markdown 渲染

**Files:**
- Create: `src/renderer/chat/markdown.ts`
- Modify: `package.json`
- Test: `tests/unit/markdown.test.ts`

**Interfaces:**
- Consumes: `marked`、`dompurify`
- Produces:`renderMarkdown(text: string): string` — 返回已消毒的 HTML 字符串

**为什么要消毒:** 模型的输出是不可信内容。它可能包含 `<script>`、`onerror` 之类的东西,直接塞进 `dangerouslySetInnerHTML` 就是脚本注入。渲染层虽然拿不到密钥(密钥只在主进程),但仍能调用所有 preload 白名单方法——删书、删对话都在里面。

- [ ] **Step 1: 装依赖并写失败的测试**

Run: `npm install marked dompurify && npm install --save-dev @types/dompurify`
(若 `dompurify` 自带类型声明则跳过第二条,在报告里说明。)

`tests/unit/markdown.test.ts`:

```ts
// @vitest-environment jsdom
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
})
```

`vitest.config.ts` 需要能跑 jsdom 环境:装 `jsdom` 作为开发依赖,配置里保持默认 `environment: 'node'`,靠文件顶部的 `@vitest-environment jsdom` 注释按文件切换。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx --no-install vitest run tests/unit/markdown.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`src/renderer/chat/markdown.ts`:

```ts
import DOMPurify from 'dompurify'
import { marked } from 'marked'

/**
 * 把模型输出的 Markdown 渲染成 HTML,并消毒。
 *
 * 模型输出是不可信内容:它可能带着 <script> 或 onerror。渲染层拿不到
 * API 密钥(密钥只在主进程),但它能调用 preload 白名单里的全部方法,
 * 包括删书和删对话——所以这里必须消毒,不能省。
 */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
}
```

- [ ] **Step 4: 运行全部测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 验证消毒是真的**

把 `DOMPurify.sanitize(raw, ...)` 临时改成直接返回 `raw`,重跑该测试文件,确认三条注入相关用例变红,再恢复并确认转绿。把三次输出贴进报告。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: render assistant markdown safely"
```

---

### Task 10: 侧边栏界面

**Files:**
- Create: `src/renderer/chat/Sidebar.tsx`
- Create: `src/renderer/chat/ConversationView.tsx`
- Create: `src/renderer/chat/HistoryList.tsx`
- Create: `src/renderer/chat/useChat.ts`
- Modify: `src/renderer/reader/ReaderView.tsx`
- Modify: `src/renderer/styles/theme.css`

**Interfaces:**
- Consumes: `window.api` 的对话与流式方法、`buildContext`、`renderMarkdown`、`createSelectionStore`、`conversationsOnPage`
- Produces:`<Sidebar book={BookRecord} engine={ReaderEngine} visible={VisibleRange | null} toc={TocItem[]} />`

**布局(来自设计文档 §5):**

```
┌─ 侧边栏 ────────────────────┐
│ 《书名》                     │  ← 常驻标题
│ 全书对话 23 条 ▸             │  ← 点开弹完整列表
├─────────────────────────────┤
│ ▸ 第 12 页 · 3 条            │  ← 当前章节内有对话的页,默认折叠
│ ▸ 第 31 页 · 1 条            │     无对话的页不出现
├─────────────────────────────┤
│ ● 第 47 页(当前)           │  ← 当前页永远展开在底部
│   ┌───────────────────────┐ │
│   │ 引用:「他终于明白…」  │ │  ← 已高亮的句子,各带一个 ×
│   └───────────────────────┘ │
│   [ 问点什么… ]   [+新对话]  │
└─────────────────────────────┘
```

**行为要点:**
- 侧边栏只列**当前章节**内有对话的页,避免长书拥挤;顶部「全书对话 N 条」点开弹完整列表。
- 流式逐字追加,Markdown 边出边渲染;回答期间显示「停止」按钮,点了保留已出内容并存库。
- 出错时按主进程给的中文原因显示 + 「重试」按钮。
- 引用区显示当前所有高亮句子,每条带 `×` 可单独移除;发送后页面高亮全部清除,句子固化进那条消息。
- 侧边栏可折叠收起,宽度状态存 `settings`。

**必须加的 test-id**(端到端要用):`sidebar`、`chat-input`、`chat-send`、`chat-stop`、`chat-retry`、`chat-error`、`message-user`、`message-assistant`、`quote-chip`、`new-conversation`、`history-entry`、`all-conversations`。

- [ ] **Step 1: 实现聊天状态钩子**

这是侧边栏里唯一有分支逻辑的部分,其余三个组件是纯展示。完整实现:

`src/renderer/chat/useChat.ts`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookRecord, MessageRecord, QuoteRecord } from '@shared/types'
import type { TocItem, VisibleRange } from '../reader/types'
import { buildContext, type ChatMessage } from './context'

export interface UseChatArgs {
  book: BookRecord
  visible: VisibleRange | null
  toc: TocItem[]
  systemPrompt: string
  contextLimit: number
  /** 当前页已存在的对话 id;没有则为 null,第一次发送时才创建 */
  conversationId: string | null
  onConversationCreated: (id: string) => void
  getQuotes: () => QuoteRecord[]
  clearQuotes: () => void
}

export interface ChatState {
  messages: MessageRecord[]
  /** 正在流式输出的那段文字;不在输出时为 null */
  streaming: string | null
  error: string | null
  send: (text: string) => Promise<void>
  stop: () => void
  retry: () => Promise<void>
  setMessages: (m: MessageRecord[]) => void
}

export function useChat(args: UseChatArgs): ChatState {
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [streaming, setStreaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 当前在跑的请求 id。流式事件是广播的,必须比对 id,否则同时开两个请求会串台。
  const requestIdRef = useRef<string | null>(null)
  const accumulatedRef = useRef('')
  const conversationRef = useRef<string | null>(args.conversationId)
  const lastAttemptRef = useRef<{ text: string; quotes: QuoteRecord[] } | null>(null)
  const disposedRef = useRef(false)

  useEffect(() => {
    conversationRef.current = args.conversationId
  }, [args.conversationId])

  /** 把已经流出来的内容落库成一条 assistant 消息。停止与正常结束都走这里。 */
  const commitAssistant = useCallback(async () => {
    const text = accumulatedRef.current
    accumulatedRef.current = ''
    requestIdRef.current = null
    setStreaming(null)
    const conversationId = conversationRef.current
    if (!conversationId || text.length === 0) return
    const saved = await window.api.appendMessage({
      conversationId,
      role: 'assistant',
      content: text,
      quotes: []
    })
    if (!disposedRef.current) setMessages((old) => [...old, saved])
  }, [])

  useEffect(() => {
    const offChunk = window.api.onChatChunk((requestId, text) => {
      if (requestId !== requestIdRef.current) return
      accumulatedRef.current += text
      setStreaming(accumulatedRef.current)
    })
    const offDone = window.api.onChatDone((requestId, failure) => {
      if (requestId !== requestIdRef.current) return
      if (failure) setError(failure)
      void commitAssistant()
    })
    return () => {
      offChunk()
      offDone()
    }
  }, [commitAssistant])

  // 卸载时中止在跑的请求,避免它继续往一个已经消失的界面推文字
  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      const id = requestIdRef.current
      if (id) void window.api.abortChat(id)
    }
  }, [])

  const run = useCallback(
    async (text: string, quotes: QuoteRecord[]) => {
      const visible = args.visible
      if (!visible) {
        setError('页面还没准备好,稍等一下再问')
        return
      }
      setError(null)
      lastAttemptRef.current = { text, quotes }

      // 空对话不入库:只有真的要发消息时才创建对话记录(设计文档 §6.3)
      let conversationId = conversationRef.current
      if (!conversationId) {
        const created = await window.api.createConversation({
          bookId: args.book.id,
          startCfi: visible.startCfi,
          endCfi: visible.endCfi,
          chapterLabel: visible.chapterLabel,
          excerpt: visible.text.slice(0, 20)
        })
        conversationId = created.id
        conversationRef.current = created.id
        args.onConversationCreated(created.id)
      }

      const history: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }))

      let assembled
      try {
        assembled = buildContext({
          systemPrompt: args.systemPrompt,
          bookTitle: args.book.title,
          author: args.book.author,
          visible,
          toc: args.toc,
          quotes,
          history,
          userText: text,
          limit: args.contextLimit
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : '上下文拼装失败')
        return
      }

      const savedUser = await window.api.appendMessage({
        conversationId,
        role: 'user',
        content: text,
        quotes
      })
      if (!disposedRef.current) setMessages((old) => [...old, savedUser])
      args.clearQuotes()

      accumulatedRef.current = ''
      setStreaming('')
      try {
        requestIdRef.current = await window.api.startChat({ messages: assembled.messages })
      } catch (e) {
        requestIdRef.current = null
        setStreaming(null)
        setError(e instanceof Error ? e.message : '请求发不出去')
      }
    },
    [args, messages]
  )

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (trimmed.length === 0) return
      await run(trimmed, args.getQuotes())
    },
    [args, run]
  )

  const retry = useCallback(async () => {
    const last = lastAttemptRef.current
    if (!last) return
    // 重试不重复保存用户消息——上一轮已经存过了,这里只重新发请求
    setError(null)
    const visible = args.visible
    const conversationId = conversationRef.current
    if (!visible || !conversationId) return
    const history: ChatMessage[] = messages
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content }))
    try {
      const assembled = buildContext({
        systemPrompt: args.systemPrompt,
        bookTitle: args.book.title,
        author: args.book.author,
        visible,
        toc: args.toc,
        quotes: last.quotes,
        history,
        userText: last.text,
        limit: args.contextLimit
      })
      accumulatedRef.current = ''
      setStreaming('')
      requestIdRef.current = await window.api.startChat({ messages: assembled.messages })
    } catch (e) {
      requestIdRef.current = null
      setStreaming(null)
      setError(e instanceof Error ? e.message : '重试失败')
    }
  }, [args, messages])

  const stop = useCallback(() => {
    const id = requestIdRef.current
    if (!id) return
    void window.api.abortChat(id)
    // 中止后主进程仍会发一次 chat:done,由它触发落库;这里不重复提交
  }, [])

  return { messages, streaming, error, send, stop, retry, setMessages }
}
```

**实现时要盯住的三点**,写完自己对照一遍:
1. 流式事件是广播给整个窗口的,`requestId` 不比对就会串台。上面每个回调的第一行都在比对。
2. 当前页还没发过消息时不得创建对话记录——空对话不入库是设计文档 §6.3 的明确规则。
3. 卸载时必须中止在跑的请求,否则主进程会一直往一个已经消失的界面推文字。

- [ ] **Step 2: 实现三个组件与样式**

按上面的布局实现 `HistoryList`(折叠条,点开加载该对话的消息)、`ConversationView`(消息流 + 引用区 + 输入框 + 停止/重试)、`Sidebar`(标题 + 全书入口 + 历史 + 当前对话)。样式追加到 `theme.css`,沿用已有的 CSS 变量,浅深主题都要能看。

- [ ] **Step 3: 接进阅读界面**

`ReaderView` 里:创建 selection store,把它和 `visible`、`toc` 传给 `Sidebar`;正文与侧边栏左右分栏,侧边栏可折叠;引擎销毁时 `store.dispose()`。

- [ ] **Step 4: 构建与冒烟**

Run: `npm run build && npm test`
Expected: 构建通过,单元测试全绿

Run: `npm run dev`,后台跑约 20 秒,确认输出无构建或启动错误后 kill。**不要声称看到了界面**——界面由 Task 13 的端到端测试验证。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: add the chat sidebar"
```

---

### Task 11: 翻页、新对话与跨页合并的接线

**Files:**
- Modify: `src/renderer/chat/Sidebar.tsx`
- Modify: `src/renderer/chat/useChat.ts`
- Modify: `src/renderer/reader/ReaderView.tsx`
- Create: `src/renderer/chat/MergeButton.tsx`

**Interfaces:**
- Consumes: `engine.setSpread(on)`、`engine.onRelocated`、`conversationsOnPage`
- Produces:三条交互规则的实现

**规则一:翻页(设计文档 §6.3)**
1. 清除所有高亮
2. 若处于双页合并态,先收回单页,停在合并的第二页(用户选的「回到 48」)
3. 当前对话有消息则折叠进历史;**一条消息都没有则直接丢弃,不入库**
4. 底部换成空白的新对话区
5. 记录阅读进度(计划一已有)

**规则二:开启新对话按钮(设计文档 §6.4)**
- 当前对话为空 → 什么都不做,不弹窗
- 当前对话有消息 → 弹窗问「保留本页当前对话?」
  - 保留 → 存库并折叠,这一页从此有两个对话
  - 不保留 → 删除当前对话,清空重来

**规则三:跨页合并(设计文档 §5)**
1. 点「合并下一页」→ 双页并排显示
2. 两页内容都进上下文,两页的句子都能划选
3. 会话管理中仍归到合并前那一页,标记为 `47(+48)`
4. 用户一翻页,双页立刻收回、对话框清空、老对话折叠
5. 合并 47+48 后再按翻页,先收回单页停在第 48 页,再按一次才到 49

- [ ] **Step 1: 实现翻页时的对话切换**

订阅 `engine.onRelocated`,在位置变化时按规则一处理。注意与计划一已有的进度保存逻辑共存——`ReaderView` 里已经有一个 `onRelocated` 订阅和一个 `restoringPosition` 标志,恢复阅读位置期间**不得**触发"翻页开新对话"。

- [ ] **Step 2: 实现新对话按钮与确认弹窗**

弹窗文案用中文,明确说明「不保留」会删除这段对话。

- [ ] **Step 3: 实现跨页合并**

「合并下一页」按钮调 `engine.setSpread(true)`;合并态下 `getVisible()` 返回的范围会覆盖两页,直接用即可。合并时把当前对话的 `mergedEndCfi` 通过 `setConversationMerge` 写库。翻页时先 `setSpread(false)` 再按规则一走。

- [ ] **Step 4: 构建与冒烟**

Run: `npm run build && npm test`
Expected: 全绿

Run: `npm run dev` 后台 20 秒,确认无启动错误后 kill。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: switch conversations on page turn and merge across pages"
```

---

### Task 12: 设置页与对话管理页

**Files:**
- Create: `src/renderer/settings/SettingsView.tsx`
- Create: `src/renderer/settings/defaults.ts`
- Create: `src/renderer/library/ConversationsView.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/library/LibraryView.tsx`
- Test: `tests/unit/settings-defaults.test.ts`

**Interfaces:**
- Produces:
  - `defaults.ts`:`DEFAULT_SYSTEM_PROMPT`、`DEFAULT_CONTEXT_LIMIT = 8000`、`SETTING_KEYS`
  - `<SettingsView onBack />`:接口地址、模型名、API 密钥、系统提示词(带「恢复默认」)、上下文上限
  - `<ConversationsView onBack />`:按书分组列出全部对话,支持多选与批量删除

**设置页要点:**
- 密钥输入框是 `type="password"`,页面只显示「已设置 / 未设置」,**永远不回显内容**——因为主进程根本不提供读取通道。
- 填了新密钥点保存才写;留空不动则保持原值;有「清除密钥」按钮。
- 「测试连接」按钮:用当前配置发一条极短的请求,把成功或分类后的中文错误显示出来。

**对话管理页要点(设计文档 §4):** 不显示页码——书没打开就没有分页。每行显示:

```
☐  第三章 那个夏天 ·「他终于明白过来,原来那天…」    5 条  3天前
☐  第五章 归途(+下一页) ·「车站空无一人…」          8 条  昨天
```

`mergedEndCfi` 非空时在章节名后加 `(+下一页)`。

**必须加的 test-id**:`settings-endpoint`、`settings-model`、`settings-apikey`、`settings-prompt`、`settings-limit`、`settings-save`、`settings-test`、`settings-status`、`conversations-view`、`conversation-row`、`conversation-delete`。

- [ ] **Step 1: 写默认值的失败测试**

`tests/unit/settings-defaults.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_SYSTEM_PROMPT,
  SETTING_KEYS
} from '../../src/renderer/settings/defaults'

describe('设置默认值', () => {
  it('默认上下文上限是 8000', () => {
    expect(DEFAULT_CONTEXT_LIMIT).toBe(8000)
  })

  it('默认提示词要求中文回答', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('中文')
  })

  it('默认提示词要求不剧透后文', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/剧透|后文/)
  })

  it('设置键名不与计划一已有的键冲突', () => {
    const existing = ['fontSize', 'theme']
    for (const key of Object.values(SETTING_KEYS)) {
      expect(existing).not.toContain(key)
    }
  })

  it('设置键名两两不重复', () => {
    const values = Object.values(SETTING_KEYS)
    expect(new Set(values).size).toBe(values.length)
  })
})
```

- [ ] **Step 2: 运行确认失败,然后实现默认值**

Run: `npx --no-install vitest run tests/unit/settings-defaults.test.ts`
Expected: FAIL — 模块不存在

`src/renderer/settings/defaults.ts`:

```ts
export const SETTING_KEYS = {
  endpoint: 'llmEndpoint',
  model: 'llmModel',
  systemPrompt: 'llmSystemPrompt',
  contextLimit: 'llmContextLimit',
  sidebarWidth: 'sidebarWidth'
} as const

export const DEFAULT_CONTEXT_LIMIT = 8000

export const DEFAULT_SYSTEM_PROMPT = [
  '你是一个电子书阅读助手。用户正在阅读一本书,你会看到书名、作者,以及用户当前这一页的正文。',
  '',
  '回答时请遵守:',
  '- 一律用简体中文回答。',
  '- 只根据用户已经读到的内容作答,不要剧透后文情节。',
  '- 简洁直接,不要复述用户已经看得到的原文。',
  '- 用户如果划选了原文片段,优先围绕那几句回答。',
  '- 不知道就说不知道,不要编造书里没有的内容。'
].join('\n')
```

Run: `npx --no-install vitest run tests/unit/settings-defaults.test.ts`
Expected: PASS

- [ ] **Step 3: 实现设置页**

按上面的要点实现。`llmContextLimit` 读出来要用计划一已有的 `getSettingNumber` 语义:存的不是数字时退回默认值,不返回 NaN。

- [ ] **Step 4: 实现对话管理页**

从书库界面进入。按书分组,每组列出该书的全部对话,支持全选、多选、批量删除,删除前弹中文确认并说明会连同消息一起删掉。

- [ ] **Step 5: 接进 App 路由**

`App.tsx` 现在只有书架与阅读两个分支,扩成四个:书架、阅读、设置、对话管理。书库界面加两个入口按钮。

- [ ] **Step 6: 构建与测试**

Run: `npm run build && npm test`
Expected: 全绿

Run: `npm run dev` 后台 20 秒,确认无启动错误后 kill。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: add the settings page and conversation manager"
```

---

### Task 13: 端到端测试

**Files:**
- Create: `tests/e2e/fake-llm.ts`
- Create: `tests/e2e/chat.spec.ts`
- Modify: `tests/e2e/helpers.ts`

**Interfaces:**
- Consumes: 计划一的 `launch()` / `importFixture()` 辅助
- Produces:一个假的 OpenAI 兼容服务,以及覆盖 AI 层关键路径的端到端用例

**假模型服务:** 用 Node 内置 `http` 起一个本地服务,接受 `POST /v1/chat/completions`,按 SSE 格式逐块吐回预设文字。它同时是断言工具——测试要检查**它收到的 messages 里到底有什么**,这是验证上下文拼装真的接上了的唯一办法。

它必须能按需模拟:正常流式、慢速流式(供"停止"用例)、401、429、连接被拒。

**必测场景:**
1. 没配置密钥时发送,提示去设置里填写,不发出任何请求
2. 配好之后提问,回答逐字出现,最终内容正确
3. 假服务收到的 system 消息里含有书名、作者、当前页正文
4. 划选一句话再提问,假服务收到的 user 消息里含有那句原文
5. 点击已高亮的句子取消,它不再出现在发出的请求里
6. 发送后页面高亮被清除
7. 回答中途点「停止」,已出的内容保留,重开这本书还在
8. 服务返回 401,界面显示的是密钥相关的中文提示,不是「出错了」
9. 点「重试」会重新发出请求
10. 翻页后侧边栏变成空白新对话,翻回去能看到刚才那段对话
11. 当前页一条消息都没发就翻页,该页不产生对话记录
12. 改字号后翻回同一段文字,对话仍然跟着那段文字出现(这是 CFI 锚定的核心承诺)
13. 「新对话」按钮在当前对话为空时不弹窗;有消息时弹窗,选「不保留」则该对话消失
14. 对话管理页能看到全部对话并批量删除,删完侧边栏历史也空了
15. 删掉一本书,它的对话一并消失

- [ ] **Step 1: 实现假模型服务**

`tests/e2e/fake-llm.ts` 导出 `startFakeLlm(): Promise<{ url: string; requests: ReceivedRequest[]; setMode(mode): void; close(): Promise<void> }>`。`requests` 累积每次收到的完整请求体,供断言。

- [ ] **Step 2: 扩充测试辅助**

`helpers.ts` 加一个 `configureLlm(harness, { endpoint, model, apiKey })`,通过设置页界面填写并保存——走真实界面而不是直接写数据库,这样设置页本身也被覆盖到。

- [ ] **Step 3: 写端到端用例**

按上面 15 条写 `tests/e2e/chat.spec.ts`。用计划一已有的 `test.afterEach` 清理机制,并确保假服务在每个用例后关闭。

- [ ] **Step 4: 运行**

Run: `npm run test:e2e`
Expected: 计划一的 12 个 + 本任务新增的全部通过。**如果某条因为应用真的坏了而失败,那是发现,不是障碍**——把测试按正确的预期写好,留它红着,在报告里精确描述:做了什么、期望什么、实际什么、你判断的原因。不要删除、跳过或放宽任何断言来换绿。

- [ ] **Step 5: 连跑两遍确认不抖**

Run: `npm run test:e2e` 再跑一遍,两次输出都贴进报告。流式与计时相关的用例最容易在第二遍暴露问题。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "test: cover the chat layer end to end"
```

---

### Task 14: 文档与发版

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-09-12-ai-reader-design.md`

- [ ] **Step 1: 更新 README**

把计划一里那句「AI 阅读助手计划在后续版本提供,本版尚未实现」删掉,改成真实的功能说明:

- 侧边栏怎么用,上下文里到底有什么(书名、作者、当前页;能读到目录和章节名时一并加入)
- 怎么配置:接口地址 + API 密钥 + 模型名,举几个常见服务商的填法(OpenAI、DeepSeek、本地 Ollama)
- 密钥存在哪:操作系统加密存储,不在数据库里,不会同步到任何地方
- 划选提问怎么操作,翻页与对话的关系
- 上下文上限与裁剪规则的一句话说明
- 「已知问题」补上这一版新发现的内容

- [ ] **Step 2: 更新版本号**

`package.json` 的 `version` 提到 `0.2.0`,`description` 改成包含 AI 功能的真实描述。

- [ ] **Step 3: 更新设计文档状态**

在设计文档顶部把状态改成「计划一、计划二均已实现」,并把实现过程中偏离原设计的地方补记进去(例如页码改用不随字号变化的位置索引、对话管理页不显示页码的理由已在文中,核对一遍是否与实现一致)。

- [ ] **Step 4: 全量验证**

Run: `npm run build && npm test && npm run test:e2e && npm run dist`
Expected: 四条全部通过,`release/` 产出 macOS 安装包

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "docs: document the chat layer and bump to 0.2.0"
```

---

## 计划二完成标准

```bash
npm run build     # 类型检查与构建无错
npm test          # 单元测试全绿(计划一 129 + 计划二新增)
npm run test:e2e  # 端到端全绿(计划一 12 + 计划二新增)
npm run dist      # 本机安装包产出成功
```

并且手工确认:配好接口后能提问、能看到逐字回答、能划选引用、能停止、能重试;翻页开新对话、翻回去看得到;改字号后对话仍跟着原文走;设置页与对话管理页可用。

## 安全底线复核清单

合并前逐条确认:

- [ ] `grep -rn "getApiKey" src/preload src/renderer` 无结果——渲染层与 preload 都没有取密钥的通道
- [ ] 密钥不出现在任何错误信息、日志或 IPC 返回值里
- [ ] 对话 id、消息 id、请求 id 全部由主进程 `randomUUID()` 生成
- [ ] 模型输出经过 DOMPurify 才进入 `dangerouslySetInnerHTML`
- [ ] 计划一的沙箱三项配置(`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`)未被改动
- [ ] preload 仍是纯透传,没有新增业务逻辑
