# AI 阅读器 · 计划一:阅读器骨架 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可独立使用的 EPUB 桌面阅读器:导入书、书库网格、开书分页、翻页、目录跳转、字号调节、浅深主题、记住阅读位置,并能打包出 macOS 与 Windows 安装包。

**Architecture:** Electron 双进程。主进程负责文件系统与 SQLite(用 Node 内置 `node:sqlite`,全程零原生模块编译);渲染进程用 React 绘制界面,并通过 `reader` 模块独占封装 epub.js。preload 用 contextBridge 暴露白名单 IPC,渲染进程不开 Node 集成。

**Tech Stack:** Electron · electron-vite · TypeScript(strict) · React 19 · epub.js · node:sqlite · Vitest(单元) · Playwright(端到端) · electron-builder · GitHub Actions

## Global Constraints

- Node ≥ 22.13。原因:数据库层用 Node 内置的 `node:sqlite`,该模块在 22.13 起无需实验开关。选它而非 better-sqlite3 是为了避免原生模块的双 ABI 问题(测试跑在 Node 下、应用跑在 Electron 下,同一个原生模块要编译两份),跨平台 CI 因此不需要任何编译步骤。
- TypeScript `strict: true`。
- 渲染进程 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。渲染层只能调用 preload 白名单里的方法。
- 只支持 EPUB。不处理 PDF / MOBI / AZW3 / TXT。
- 所有用户可见文案用简体中文。
- `src/renderer/reader/engine.ts` 是全项目唯一 `import` epub.js 的文件。其他任何文件出现 `from 'epubjs'` 视为违规。
- 应用数据目录必须经 `src/main/paths.ts` 解析,禁止在其他文件里拼 `app.getPath('userData')`。测试靠环境变量 `READER_USER_DATA` 覆盖该目录。
- 不做代码签名。
- 页码定义:`epub.js` 的 locations 索引 + 1,总页数为 `locations.total`。该索引按字数均匀切分,不随字号变化。「当前页内容」另取屏幕实际可见范围,两者不是一回事,不要混用。
- 每个任务结束必须提交一次 git commit。

## 文件结构

| 文件 | 职责 |
|---|---|
| `electron.vite.config.ts` | 三端(main/preload/renderer)构建配置 |
| `vitest.config.ts` | 单元测试配置,只收 `tests/unit/**` |
| `playwright.config.ts` | 端到端测试配置 |
| `src/main/index.ts` | 主进程入口,创建窗口,装配 IPC |
| `src/main/paths.ts` | 应用数据目录解析(唯一来源) |
| `src/main/db/index.ts` | 数据库连接与建表 |
| `src/main/db/books.ts` | books 表读写 |
| `src/main/db/settings.ts` | settings 键值表读写 |
| `src/main/books/import.ts` | 复制 EPUB 到应用目录、写封面 |
| `src/main/books/scan.ts` | 扫描文件夹找出未导入的 EPUB |
| `src/main/ipc.ts` | IPC 通道注册汇总 |
| `src/preload/index.ts` | contextBridge 暴露 `window.api` |
| `src/shared/types.ts` | 主进程与渲染进程共用的类型 |
| `src/renderer/main.tsx` | React 挂载点 |
| `src/renderer/App.tsx` | 书库 / 阅读两个视图的切换 |
| `src/renderer/library/LibraryView.tsx` | 书库网格与导入入口 |
| `src/renderer/library/metadata.ts` | 用 epub.js 提取书名/作者/封面 |
| `src/renderer/reader/engine.ts` | epub.js 封装(唯一接触点) |
| `src/renderer/reader/cfi.ts` | 起止 CFI 合成范围 CFI |
| `src/renderer/reader/ReaderView.tsx` | 阅读界面 |
| `src/renderer/reader/TocPanel.tsx` | 目录面板 |
| `src/renderer/styles/theme.css` | 主题变量与全局样式 |
| `scripts/make-fixture-epub.ts` | 生成测试用 EPUB 样本 |

---

### Task 1: 项目脚手架与测试基建

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `electron.vite.config.ts`
- Create: `vitest.config.ts`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`
- Create: `src/shared/types.ts`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Consumes: 无(首个任务)
- Produces: `npm run dev` 启动应用;`npm test` 跑单元测试;`npm run build` 产出 `out/main/index.js`、`out/preload/index.js`、`out/renderer/`

- [ ] **Step 1: 写失败的测试**

`tests/unit/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

describe('运行环境', () => {
  it('Node 版本不低于 22.13,否则 node:sqlite 不可用', async () => {
    const [major, minor] = process.versions.node.split('.').map(Number)
    expect(major > 22 || (major === 22 && minor >= 13)).toBe(true)
  })

  it('node:sqlite 可直接导入并建表', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (a TEXT)')
    db.prepare('INSERT INTO t (a) VALUES (?)').run('hi')
    const row = db.prepare('SELECT a FROM t').get() as { a: string }
    expect(row.a).toBe('hi')
    db.close()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/env.test.ts`
Expected: FAIL — 报找不到配置或找不到 vitest(尚未安装依赖)

- [ ] **Step 3: 写 package.json**

```json
{
  "name": "ai-reader",
  "version": "0.1.0",
  "description": "带 AI 对话侧边栏的 EPUB 阅读器",
  "main": "./out/main/index.js",
  "type": "module",
  "engines": { "node": ">=22.13" },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "tsc --noEmit && electron-vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "npm run build && playwright test",
    "fixture": "tsx scripts/make-fixture-epub.ts",
    "dist": "npm run build && electron-builder"
  },
  "dependencies": {
    "epubjs": "^0.3.93"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "electron": "^33.2.0",
    "electron-builder": "^25.1.8",
    "electron-vite": "^2.3.0",
    "jszip": "^3.10.1",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vite": "^5.4.11",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 4: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node", "vitest/globals"],
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src", "tests", "scripts", "*.config.ts"]
}
```

`tsconfig.node.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "lib": ["ES2023"] },
  "include": ["src/main", "src/preload", "src/shared", "scripts"]
}
```

- [ ] **Step 5: 写 electron.vite.config.ts**

```ts
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    resolve: {
      alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer') }
    },
    plugins: [react()]
  }
})
```

- [ ] **Step 6: 写 vitest.config.ts**

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/unit/**/*.test.ts']
  }
})
```

- [ ] **Step 7: 写共用类型**

`src/shared/types.ts`:

```ts
export interface BookRecord {
  id: string
  title: string
  author: string | null
  coverPath: string | null
  filePath: string
  addedAt: number
  lastReadCfi: string | null
  lastReadAt: number | null
}

export interface ImportedFile {
  id: string
  filePath: string
}
```

- [ ] **Step 8: 写主进程入口**

`src/main/index.ts`:

```ts
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'AI 阅读器',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 9: 写 preload 与渲染层骨架**

`src/preload/index.ts`:

```ts
import { contextBridge } from 'electron'

const api = {
  ping: (): string => 'pong'
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
```

`src/renderer/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI 阅读器</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/renderer/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

`src/renderer/App.tsx`:

```tsx
export default function App() {
  return <main>AI 阅读器</main>
}
```

- [ ] **Step 10: 安装依赖并运行测试**

Run: `npm install && npm test`
Expected: PASS — 两个用例都通过。若第一个用例失败,说明本机 Node 低于 22.13,需先升级 Node 再继续。

- [ ] **Step 11: 确认应用能启动**

Run: `npm run dev`
Expected: 弹出标题为「AI 阅读器」的窗口,窗口内显示文字「AI 阅读器」。确认后关掉窗口。

- [ ] **Step 12: 提交**

```bash
git add -A
git commit -m "feat: scaffold electron app with vite, react, and vitest"
```

---

### Task 2: 应用数据目录与数据库建表

**Files:**
- Create: `src/main/paths.ts`
- Create: `src/main/db/index.ts`
- Create: `src/main/db/settings.ts`
- Test: `tests/unit/paths.test.ts`
- Test: `tests/unit/db-settings.test.ts`

**Interfaces:**
- Consumes: Task 1 的 vitest 配置
- Produces:
  - `resolveDataDir(): string`、`booksDir(): string`、`coversDir(): string`、`dbFile(): string`
  - `openDatabase(file: string): DatabaseSync`(已建好全部表)
  - `getSetting(db, key): string | null`、`setSetting(db, key, value): void`、`getSettingNumber(db, key, fallback): number`

- [ ] **Step 1: 写 paths 的失败测试**

`tests/unit/paths.test.ts`:

```ts
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { booksDir, coversDir, dbFile, resolveDataDir } from '../../src/main/paths'

const original = process.env.READER_USER_DATA

afterEach(() => {
  if (original === undefined) delete process.env.READER_USER_DATA
  else process.env.READER_USER_DATA = original
})

describe('应用数据目录', () => {
  it('READER_USER_DATA 存在时以它为根', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-'))
    process.env.READER_USER_DATA = dir
    expect(resolveDataDir()).toBe(dir)
    expect(booksDir()).toBe(join(dir, 'books'))
    expect(coversDir()).toBe(join(dir, 'covers'))
    expect(dbFile()).toBe(join(dir, 'reader.db'))
  })

  it('调用后子目录已被建出来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-'))
    process.env.READER_USER_DATA = dir
    const b = booksDir()
    const c = coversDir()
    expect(existsSync(b)).toBe(true)
    expect(existsSync(c)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/paths.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/main/paths"`

- [ ] **Step 3: 实现 paths**

`src/main/paths.ts`:

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 应用数据目录的唯一来源。
 * 测试与端到端用 READER_USER_DATA 覆盖,避免污染真实用户目录。
 */
export function resolveDataDir(): string {
  const override = process.env.READER_USER_DATA
  if (override) {
    mkdirSync(override, { recursive: true })
    return override
  }
  // 延迟到运行时再取,单元测试不加载 electron
  const { app } = require('electron') as typeof import('electron')
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

function sub(name: string): string {
  const dir = join(resolveDataDir(), name)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function booksDir(): string {
  return sub('books')
}

export function coversDir(): string {
  return sub('covers')
}

export function dbFile(): string {
  return join(resolveDataDir(), 'reader.db')
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/paths.test.ts`
Expected: PASS — 2 个用例通过

- [ ] **Step 5: 写数据库层的失败测试**

`tests/unit/db-settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import { getSetting, getSettingNumber, setSetting } from '../../src/main/db/settings'

describe('设置表', () => {
  it('没写过的键读出来是 null', () => {
    const db = openDatabase(':memory:')
    expect(getSetting(db, 'fontSize')).toBeNull()
    db.close()
  })

  it('写入后能读回', () => {
    const db = openDatabase(':memory:')
    setSetting(db, 'theme', 'dark')
    expect(getSetting(db, 'theme')).toBe('dark')
    db.close()
  })

  it('同一个键重复写是覆盖不是报错', () => {
    const db = openDatabase(':memory:')
    setSetting(db, 'theme', 'dark')
    setSetting(db, 'theme', 'light')
    expect(getSetting(db, 'theme')).toBe('light')
    db.close()
  })

  it('数字读取:没写过给默认值,写过的转成数字', () => {
    const db = openDatabase(':memory:')
    expect(getSettingNumber(db, 'fontSize', 18)).toBe(18)
    setSetting(db, 'fontSize', '22')
    expect(getSettingNumber(db, 'fontSize', 18)).toBe(22)
    db.close()
  })

  it('存的不是数字时退回默认值,不返回 NaN', () => {
    const db = openDatabase(':memory:')
    setSetting(db, 'fontSize', '大号')
    expect(getSettingNumber(db, 'fontSize', 18)).toBe(18)
    db.close()
  })
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/unit/db-settings.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/main/db"`

- [ ] **Step 7: 实现数据库层**

`src/main/db/index.ts`:

```ts
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  author        TEXT,
  cover_path    TEXT,
  file_path     TEXT NOT NULL,
  locations     TEXT,
  added_at      INTEGER NOT NULL,
  last_read_cfi TEXT,
  last_read_at  INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export type Db = DatabaseSync

/** 打开数据库并确保表结构存在。传 ':memory:' 得到一个测试用的临时库。 */
export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
```

`src/main/db/settings.ts`:

```ts
import type { Db } from './index'

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export function getSettingNumber(db: Db, key: string, fallback: number): number {
  const raw = getSetting(db, key)
  if (raw === null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}
```

- [ ] **Step 8: 运行全部单元测试**

Run: `npm test`
Expected: PASS — env、paths、db-settings 共 9 个用例通过

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat: add data directory resolution and sqlite settings store"
```

---

### Task 3: books 表读写

**Files:**
- Create: `src/main/db/books.ts`
- Test: `tests/unit/db-books.test.ts`

**Interfaces:**
- Consumes: `openDatabase(file)`、`BookRecord`
- Produces:
  - `insertBook(db, book: BookRecord): void`
  - `listBooks(db): BookRecord[]`(按上次打开时间倒序,从未打开的排最后按导入时间倒序)
  - `getBook(db, id): BookRecord | null`
  - `deleteBook(db, id): void`
  - `updateProgress(db, id, cfi: string): void`
  - `getLocations(db, id): string | null` / `setLocations(db, id, json: string): void`

- [ ] **Step 1: 写失败的测试**

`tests/unit/db-books.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import {
  deleteBook,
  getBook,
  getLocations,
  insertBook,
  listBooks,
  setLocations,
  updateProgress
} from '../../src/main/db/books'
import type { BookRecord } from '../../src/shared/types'

function make(id: string, over: Partial<BookRecord> = {}): BookRecord {
  return {
    id,
    title: `书 ${id}`,
    author: '某人',
    coverPath: null,
    filePath: `/data/books/${id}.epub`,
    addedAt: 1000,
    lastReadCfi: null,
    lastReadAt: null,
    ...over
  }
}

describe('books 表', () => {
  it('插入后能按 id 取回,字段一致', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a', { author: null, coverPath: '/c/a.png' }))
    const got = getBook(db, 'a')
    expect(got).toEqual(make('a', { author: null, coverPath: '/c/a.png' }))
    db.close()
  })

  it('取不存在的 id 返回 null 而不是抛异常', () => {
    const db = openDatabase(':memory:')
    expect(getBook(db, '不存在')).toBeNull()
    db.close()
  })

  it('列表把读过的排在前面,同类按时间倒序', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('老书', { addedAt: 1 }))
    insertBook(db, make('新书', { addedAt: 2 }))
    insertBook(db, make('读过的', { addedAt: 0, lastReadAt: 500 }))
    expect(listBooks(db).map((b) => b.id)).toEqual(['读过的', '新书', '老书'])
    db.close()
  })

  it('更新进度会同时写入位置和时间', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a'))
    updateProgress(db, 'a', 'epubcfi(/6/4!/4/2/2)')
    const got = getBook(db, 'a')!
    expect(got.lastReadCfi).toBe('epubcfi(/6/4!/4/2/2)')
    expect(got.lastReadAt).toBeGreaterThan(0)
    db.close()
  })

  it('删除后列表里没有了', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a'))
    deleteBook(db, 'a')
    expect(listBooks(db)).toEqual([])
    db.close()
  })

  it('分页位置索引可存可取,没存过是 null', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a'))
    expect(getLocations(db, 'a')).toBeNull()
    setLocations(db, 'a', '["cfi1","cfi2"]')
    expect(getLocations(db, 'a')).toBe('["cfi1","cfi2"]')
    db.close()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/db-books.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/main/db/books"`

- [ ] **Step 3: 实现 books 表读写**

`src/main/db/books.ts`:

```ts
import type { BookRecord } from '../../shared/types'
import type { Db } from './index'

interface Row {
  id: string
  title: string
  author: string | null
  cover_path: string | null
  file_path: string
  added_at: number
  last_read_cfi: string | null
  last_read_at: number | null
}

function toRecord(row: Row): BookRecord {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    coverPath: row.cover_path,
    filePath: row.file_path,
    addedAt: row.added_at,
    lastReadCfi: row.last_read_cfi,
    lastReadAt: row.last_read_at
  }
}

const SELECT = `SELECT id, title, author, cover_path, file_path, added_at, last_read_cfi, last_read_at FROM books`

export function insertBook(db: Db, book: BookRecord): void {
  db.prepare(
    `INSERT INTO books (id, title, author, cover_path, file_path, added_at, last_read_cfi, last_read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    book.id,
    book.title,
    book.author,
    book.coverPath,
    book.filePath,
    book.addedAt,
    book.lastReadCfi,
    book.lastReadAt
  )
}

export function getBook(db: Db, id: string): BookRecord | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined
  return row ? toRecord(row) : null
}

/** 读过的排前面(按上次打开时间倒序),没读过的排后面(按导入时间倒序)。 */
export function listBooks(db: Db): BookRecord[] {
  const rows = db
    .prepare(
      `${SELECT}
       ORDER BY (last_read_at IS NULL) ASC,
                last_read_at DESC,
                added_at DESC`
    )
    .all() as Row[]
  return rows.map(toRecord)
}

export function deleteBook(db: Db, id: string): void {
  db.prepare('DELETE FROM books WHERE id = ?').run(id)
}

export function updateProgress(db: Db, id: string, cfi: string): void {
  db.prepare('UPDATE books SET last_read_cfi = ?, last_read_at = ? WHERE id = ?').run(
    cfi,
    Date.now(),
    id
  )
}

export function getLocations(db: Db, id: string): string | null {
  const row = db.prepare('SELECT locations FROM books WHERE id = ?').get(id) as
    | { locations: string | null }
    | undefined
  return row?.locations ?? null
}

export function setLocations(db: Db, id: string, json: string): void {
  db.prepare('UPDATE books SET locations = ? WHERE id = ?').run(json, id)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS — 全部 15 个用例通过

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: add books table repository"
```

---

### Task 4: 导入时的文件复制与封面落盘

**Files:**
- Create: `src/main/books/import.ts`
- Test: `tests/unit/books-import.test.ts`

**Interfaces:**
- Consumes: `booksDir()`、`coversDir()`
- Produces:
  - `copyEpubIntoLibrary(sourcePath: string): Promise<ImportedFile>` — 返回新生成的书 id 与库内文件路径
  - `writeCover(bookId: string, bytes: Uint8Array): Promise<string>` — 返回封面文件路径
  - `removeBookFiles(book: { filePath: string; coverPath: string | null }): Promise<void>`

- [ ] **Step 1: 写失败的测试**

`tests/unit/books-import.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  copyEpubIntoLibrary,
  removeBookFiles,
  writeCover
} from '../../src/main/books/import'

let dataDir: string
let workDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'reader-data-'))
  workDir = mkdtempSync(join(tmpdir(), 'reader-work-'))
  process.env.READER_USER_DATA = dataDir
})

describe('导入文件', () => {
  it('把源文件复制进库,内容一致', async () => {
    const src = join(workDir, '测试书.epub')
    writeFileSync(src, 'EPUB-CONTENT')
    const result = await copyEpubIntoLibrary(src)
    expect(existsSync(result.filePath)).toBe(true)
    expect(readFileSync(result.filePath, 'utf8')).toBe('EPUB-CONTENT')
  })

  it('复制后删掉源文件不影响库内副本', async () => {
    const src = join(workDir, '测试书.epub')
    writeFileSync(src, 'EPUB-CONTENT')
    const result = await copyEpubIntoLibrary(src)
    const { rmSync } = await import('node:fs')
    rmSync(src)
    expect(readFileSync(result.filePath, 'utf8')).toBe('EPUB-CONTENT')
  })

  it('同一个文件导入两次得到两个不同的 id 和两份副本', async () => {
    const src = join(workDir, '测试书.epub')
    writeFileSync(src, 'X')
    const a = await copyEpubIntoLibrary(src)
    const b = await copyEpubIntoLibrary(src)
    expect(a.id).not.toBe(b.id)
    expect(a.filePath).not.toBe(b.filePath)
    expect(existsSync(a.filePath)).toBe(true)
    expect(existsSync(b.filePath)).toBe(true)
  })

  it('源文件不存在时抛出带路径的错误', async () => {
    await expect(copyEpubIntoLibrary(join(workDir, '没有这个.epub'))).rejects.toThrow(
      /没有这个\.epub/
    )
  })

  it('封面写入后能读回原始字节', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const path = await writeCover('book-1', bytes)
    expect(Array.from(readFileSync(path))).toEqual([137, 80, 78, 71])
  })

  it('删除会同时清掉书文件和封面,重复删除不报错', async () => {
    const src = join(workDir, 'a.epub')
    writeFileSync(src, 'X')
    const imported = await copyEpubIntoLibrary(src)
    const cover = await writeCover(imported.id, new Uint8Array([1]))
    await removeBookFiles({ filePath: imported.filePath, coverPath: cover })
    expect(existsSync(imported.filePath)).toBe(false)
    expect(existsSync(cover)).toBe(false)
    await expect(
      removeBookFiles({ filePath: imported.filePath, coverPath: cover })
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/books-import.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/main/books/import"`

- [ ] **Step 3: 实现导入**

`src/main/books/import.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { access, copyFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImportedFile } from '../../shared/types'
import { booksDir, coversDir } from '../paths'

/**
 * 把用户选中的 EPUB 复制进应用目录。
 * 每次导入生成新 id,同一本书导入两次会得到两条独立记录——
 * 判重留给上层(扫描时按源路径过滤),这里只负责复制。
 */
export async function copyEpubIntoLibrary(sourcePath: string): Promise<ImportedFile> {
  try {
    await access(sourcePath)
  } catch {
    throw new Error(`找不到文件:${sourcePath}`)
  }
  const id = randomUUID()
  const filePath = join(booksDir(), `${id}.epub`)
  await copyFile(sourcePath, filePath)
  return { id, filePath }
}

export async function writeCover(bookId: string, bytes: Uint8Array): Promise<string> {
  const path = join(coversDir(), `${bookId}.png`)
  await writeFile(path, bytes)
  return path
}

export async function removeBookFiles(book: {
  filePath: string
  coverPath: string | null
}): Promise<void> {
  await rm(book.filePath, { force: true })
  if (book.coverPath) await rm(book.coverPath, { force: true })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS — 全部 21 个用例通过

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: copy imported epubs into the app library directory"
```

---

### Task 5: 扫描文件夹找出未导入的 EPUB

**Files:**
- Create: `src/main/books/scan.ts`
- Test: `tests/unit/books-scan.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `scanFolder(dir: string, alreadyImported: string[]): Promise<string[]>` — 递归找出 `.epub` 文件,排除掉已导入过的源路径,按路径排序返回

- [ ] **Step 1: 写失败的测试**

`tests/unit/books-scan.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { scanFolder } from '../../src/main/books/scan'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reader-scan-'))
})

describe('扫描文件夹', () => {
  it('找出顶层和子目录里的 epub', async () => {
    writeFileSync(join(dir, 'a.epub'), '')
    mkdirSync(join(dir, '子目录'))
    writeFileSync(join(dir, '子目录', 'b.epub'), '')
    const found = await scanFolder(dir, [])
    expect(found).toEqual([join(dir, 'a.epub'), join(dir, '子目录', 'b.epub')])
  })

  it('忽略非 epub 文件', async () => {
    writeFileSync(join(dir, 'a.epub'), '')
    writeFileSync(join(dir, 'b.pdf'), '')
    writeFileSync(join(dir, 'c.txt'), '')
    expect(await scanFolder(dir, [])).toEqual([join(dir, 'a.epub')])
  })

  it('扩展名大小写不敏感', async () => {
    writeFileSync(join(dir, 'a.EPUB'), '')
    expect(await scanFolder(dir, [])).toEqual([join(dir, 'a.EPUB')])
  })

  it('排除已导入过的路径', async () => {
    writeFileSync(join(dir, 'a.epub'), '')
    writeFileSync(join(dir, 'b.epub'), '')
    expect(await scanFolder(dir, [join(dir, 'a.epub')])).toEqual([join(dir, 'b.epub')])
  })

  it('目录不存在时抛出带路径的错误', async () => {
    await expect(scanFolder(join(dir, '没有'), [])).rejects.toThrow(/没有/)
  })

  it('空目录返回空数组', async () => {
    expect(await scanFolder(dir, [])).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/books-scan.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/main/books/scan"`

- [ ] **Step 3: 实现扫描**

`src/main/books/scan.ts`:

```ts
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, out)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.epub')) {
      out.push(full)
    }
  }
}

/** 递归找出文件夹下所有 EPUB,排除掉已经导入过的源路径。 */
export async function scanFolder(dir: string, alreadyImported: string[]): Promise<string[]> {
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(`找不到文件夹:${dir}`)
  }
  const found: string[] = []
  await walk(dir, found)
  const skip = new Set(alreadyImported)
  return found.filter((p) => !skip.has(p)).sort()
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS — 全部 27 个用例通过

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: scan folders for epub files"
```

---

### Task 6: IPC 通道与 preload 桥

**Files:**
- Create: `src/main/ipc.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/env.d.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Consumes: Task 2–5 的全部模块
- Produces: 渲染层可用的 `window.api`:
  - `listBooks(): Promise<BookRecord[]>`
  - `pickEpubFiles(): Promise<string[]>`
  - `pickFolder(): Promise<string | null>`
  - `scanFolder(dir: string): Promise<string[]>`
  - `stageImport(sourcePaths: string[]): Promise<ImportedFile[]>`
  - `finishImport(input: FinishImportInput): Promise<BookRecord>`
  - `readBookFile(id: string): Promise<ArrayBuffer>`
  - `readStagedFile(filePath: string): Promise<ArrayBuffer>`(读刚复制进库、尚未入库的文件)
  - `deleteBook(id: string): Promise<void>`
  - `saveProgress(id: string, cfi: string): Promise<void>`
  - `getLocations(id): Promise<string | null>` / `saveLocations(id, json): Promise<void>`
  - `getSetting(key): Promise<string | null>` / `setSetting(key, value): Promise<void>`

- [ ] **Step 1: 扩充共用类型**

在 `src/shared/types.ts` 末尾追加:

```ts
export interface FinishImportInput {
  id: string
  filePath: string
  sourcePath: string
  title: string
  author: string | null
  coverBytes: number[] | null
}
```

并把 `BookRecord` 增加一个字段(书库要能按源路径判重):

```ts
export interface BookRecord {
  id: string
  title: string
  author: string | null
  coverPath: string | null
  filePath: string
  sourcePath: string
  addedAt: number
  lastReadCfi: string | null
  lastReadAt: number | null
}
```

- [ ] **Step 2: 让 books 表带上 source_path,先改测试**

在 `src/main/db/index.ts` 的 `SCHEMA` 里,`file_path TEXT NOT NULL,` 之后加一行:

```sql
  source_path   TEXT NOT NULL DEFAULT '',
```

在 `tests/unit/db-books.test.ts` 的 `make()` 里补上字段:

```ts
    filePath: `/data/books/${id}.epub`,
    sourcePath: `/Users/me/Downloads/${id}.epub`,
```

再追加一个用例:

```ts
  it('能按源路径列出已导入的书,用于扫描判重', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a'))
    insertBook(db, make('b'))
    expect(listSourcePaths(db).sort()).toEqual([
      '/Users/me/Downloads/a.epub',
      '/Users/me/Downloads/b.epub'
    ])
    db.close()
  })
```

并在该文件的 import 里加上 `listSourcePaths`。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/unit/db-books.test.ts`
Expected: FAIL — `listSourcePaths is not exported` 以及 `sourcePath` 字段对不上

- [ ] **Step 4: 改 books 表读写以支持源路径**

`src/main/db/books.ts` 中,`Row` 接口加 `source_path: string`;`toRecord` 加 `sourcePath: row.source_path`;`SELECT` 常量改为:

```ts
const SELECT = `SELECT id, title, author, cover_path, file_path, source_path, added_at, last_read_cfi, last_read_at FROM books`
```

`insertBook` 改为:

```ts
export function insertBook(db: Db, book: BookRecord): void {
  db.prepare(
    `INSERT INTO books (id, title, author, cover_path, file_path, source_path, added_at, last_read_cfi, last_read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    book.id,
    book.title,
    book.author,
    book.coverPath,
    book.filePath,
    book.sourcePath,
    book.addedAt,
    book.lastReadCfi,
    book.lastReadAt
  )
}
```

文件末尾加:

```ts
export function listSourcePaths(db: Db): string[] {
  const rows = db.prepare('SELECT source_path FROM books').all() as { source_path: string }[]
  return rows.map((r) => r.source_path).filter((p) => p.length > 0)
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS — 全部 28 个用例通过

- [ ] **Step 6: 实现 IPC 注册**

`src/main/ipc.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { dialog, ipcMain } from 'electron'
import type { BookRecord, FinishImportInput, ImportedFile } from '../shared/types'
import { copyEpubIntoLibrary, removeBookFiles, writeCover } from './books/import'
import { scanFolder } from './books/scan'
import { openDatabase, type Db } from './db'
import {
  deleteBook,
  getBook,
  getLocations,
  insertBook,
  listBooks,
  listSourcePaths,
  setLocations,
  updateProgress
} from './db/books'
import { getSetting, setSetting } from './db/settings'
import { booksDir, dbFile } from './paths'

let db: Db | null = null

function database(): Db {
  if (!db) db = openDatabase(dbFile())
  return db
}

export function registerIpc(): void {
  ipcMain.handle('books:list', (): BookRecord[] => listBooks(database()))

  ipcMain.handle('books:pickFiles', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: '选择 EPUB 文件',
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
      properties: ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('books:pickFolder', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择书库文件夹',
      properties: ['openDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('books:scanFolder', (_e, dir: string): Promise<string[]> =>
    scanFolder(dir, listSourcePaths(database()))
  )

  ipcMain.handle(
    'books:stageImport',
    async (_e, sourcePaths: string[]): Promise<ImportedFile[]> => {
      const out: ImportedFile[] = []
      for (const p of sourcePaths) out.push(await copyEpubIntoLibrary(p))
      return out
    }
  )

  ipcMain.handle(
    'books:finishImport',
    async (_e, input: FinishImportInput): Promise<BookRecord> => {
      const coverPath = input.coverBytes
        ? await writeCover(input.id, Uint8Array.from(input.coverBytes))
        : null
      const record: BookRecord = {
        id: input.id,
        title: input.title || basename(input.sourcePath, '.epub'),
        author: input.author,
        coverPath,
        filePath: input.filePath,
        sourcePath: input.sourcePath,
        addedAt: Date.now(),
        lastReadCfi: null,
        lastReadAt: null
      }
      insertBook(database(), record)
      return record
    }
  )

  ipcMain.handle('books:readFile', async (_e, id: string): Promise<ArrayBuffer> => {
    const book = getBook(database(), id)
    if (!book) throw new Error(`书不存在:${id}`)
    const buf = await readFile(book.filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })

  // 刚复制进库、还没入库的文件靠这个读。路径必须落在书库目录内,
  // 否则等于把任意文件读取权开放给了渲染层。
  ipcMain.handle('books:readStaged', async (_e, filePath: string): Promise<ArrayBuffer> => {
    const root = booksDir()
    const full = resolve(filePath)
    if (!full.startsWith(root)) throw new Error('路径不在书库目录内')
    const buf = await readFile(full)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })

  ipcMain.handle('books:delete', async (_e, id: string): Promise<void> => {
    const book = getBook(database(), id)
    if (!book) return
    await removeBookFiles(book)
    deleteBook(database(), id)
  })

  ipcMain.handle('books:saveProgress', (_e, id: string, cfi: string): void => {
    updateProgress(database(), id, cfi)
  })

  ipcMain.handle('books:getLocations', (_e, id: string): string | null =>
    getLocations(database(), id)
  )

  ipcMain.handle('books:saveLocations', (_e, id: string, json: string): void => {
    setLocations(database(), id, json)
  })

  ipcMain.handle('settings:get', (_e, key: string): string | null =>
    getSetting(database(), key)
  )

  ipcMain.handle('settings:set', (_e, key: string, value: string): void => {
    setSetting(database(), key, value)
  })
}
```

- [ ] **Step 7: 在主进程装配 IPC**

`src/main/index.ts` 顶部 import 加:

```ts
import { registerIpc } from './ipc'
```

把 `app.whenReady().then(...)` 改成:

```ts
void app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
```

- [ ] **Step 8: 实现 preload 桥**

`src/preload/index.ts` 整个替换为:

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { BookRecord, FinishImportInput, ImportedFile } from '../shared/types'

const api = {
  listBooks: (): Promise<BookRecord[]> => ipcRenderer.invoke('books:list'),
  pickEpubFiles: (): Promise<string[]> => ipcRenderer.invoke('books:pickFiles'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('books:pickFolder'),
  scanFolder: (dir: string): Promise<string[]> => ipcRenderer.invoke('books:scanFolder', dir),
  stageImport: (sourcePaths: string[]): Promise<ImportedFile[]> =>
    ipcRenderer.invoke('books:stageImport', sourcePaths),
  finishImport: (input: FinishImportInput): Promise<BookRecord> =>
    ipcRenderer.invoke('books:finishImport', input),
  readBookFile: (id: string): Promise<ArrayBuffer> => ipcRenderer.invoke('books:readFile', id),
  readStagedFile: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('books:readStaged', filePath),
  deleteBook: (id: string): Promise<void> => ipcRenderer.invoke('books:delete', id),
  saveProgress: (id: string, cfi: string): Promise<void> =>
    ipcRenderer.invoke('books:saveProgress', id, cfi),
  getLocations: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('books:getLocations', id),
  saveLocations: (id: string, json: string): Promise<void> =>
    ipcRenderer.invoke('books:saveLocations', id, json),
  getSetting: (key: string): Promise<string | null> => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('settings:set', key, value)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
```

`src/renderer/env.d.ts`:

```ts
/// <reference types="vite/client" />
import type { Api } from '../preload'

declare global {
  interface Window {
    api: Api
  }
}

export {}
```

- [ ] **Step 9: 类型检查与测试**

Run: `npm run build && npm test`
Expected: 构建成功,单元测试全通过

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "feat: expose book and settings operations over ipc"
```

---

### Task 7: 测试样本 EPUB 生成脚本

**Files:**
- Create: `scripts/make-fixture-epub.ts`
- Create: `tests/unit/fixture.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 无
- Produces: `buildFixtureEpub(): Promise<Uint8Array>`;运行 `npm run fixture` 在 `tests/fixtures/sample.epub` 生成一本三章中文样本书,书名「测试之书」,作者「测试作者」

**为什么自己生成而不是下载现成的书:** 端到端测试要断言「第 47 页显示了什么」,内容必须完全确定。从网上下的书随时可能变,且给仓库塞进几 MB 二进制文件。

- [ ] **Step 1: 写失败的测试**

`tests/unit/fixture.test.ts`:

```ts
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildFixtureEpub } from '../../scripts/make-fixture-epub'

describe('样本 EPUB', () => {
  it('是个 zip,且第一个条目是未压缩的 mimetype', async () => {
    const bytes = await buildFixtureEpub()
    const text = new TextDecoder().decode(bytes.slice(0, 60))
    expect(text).toContain('mimetype')
    expect(text).toContain('application/epub+zip')
  })

  it('包含 EPUB 必需的文件', async () => {
    const zip = await JSZip.loadAsync(await buildFixtureEpub())
    const names = Object.keys(zip.files)
    expect(names).toContain('META-INF/container.xml')
    expect(names).toContain('OEBPS/content.opf')
    expect(names).toContain('OEBPS/nav.xhtml')
    expect(names).toContain('OEBPS/ch1.xhtml')
    expect(names).toContain('OEBPS/ch2.xhtml')
    expect(names).toContain('OEBPS/ch3.xhtml')
  })

  it('元数据写的是约定好的书名和作者', async () => {
    const zip = await JSZip.loadAsync(await buildFixtureEpub())
    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    expect(opf).toContain('<dc:title>测试之书</dc:title>')
    expect(opf).toContain('<dc:creator>测试作者</dc:creator>')
  })

  it('正文足够长,至少能分出好几页', async () => {
    const zip = await JSZip.loadAsync(await buildFixtureEpub())
    const ch1 = await zip.file('OEBPS/ch1.xhtml')!.async('string')
    expect(ch1.length).toBeGreaterThan(4000)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/fixture.test.ts`
Expected: FAIL — `Failed to resolve import "../../scripts/make-fixture-epub"`

- [ ] **Step 3: 实现生成脚本**

`scripts/make-fixture-epub.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import JSZip from 'jszip'

const CHAPTERS = [
  { id: 'ch1', title: '第一章 开端', seed: '开端' },
  { id: 'ch2', title: '第二章 那个夏天', seed: '夏天' },
  { id: 'ch3', title: '第三章 归途', seed: '归途' }
]

/** 每章生成 60 段确定性中文正文,内容只取决于章节序号和段落序号。 */
function body(seed: string): string {
  const paragraphs: string[] = []
  for (let i = 1; i <= 60; i++) {
    paragraphs.push(
      `<p>${seed}的第${i}段。这是一段用于测试分页与划选的正文,它没有实际含义,` +
        `只保证每次生成完全相同。段落编号${i},长度固定,便于断言页面内容。</p>`
    )
  }
  return paragraphs.join('\n')
}

function chapterXhtml(title: string, seed: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>${title}</title></head>
<body><h1>${title}</h1>
${body(seed)}
</body></html>`
}

export async function buildFixtureEpub(): Promise<Uint8Array> {
  const zip = new JSZip()

  // mimetype 必须是压缩包里第一个条目且不压缩,否则部分阅读器拒绝打开
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  )

  const manifest = CHAPTERS.map(
    (c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n    ')
  const spine = CHAPTERS.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ')

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:reader-fixture-0001</dc:identifier>
    <dc:title>测试之书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`
  )

  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
${CHAPTERS.map((c) => `      <li><a href="${c.id}.xhtml">${c.title}</a></li>`).join('\n')}
    </ol>
  </nav>
</body></html>`
  )

  for (const c of CHAPTERS) {
    zip.file(`OEBPS/${c.id}.xhtml`, chapterXhtml(c.title, c.seed))
  }

  return zip.generateAsync({ type: 'uint8array' })
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('make-fixture-epub.ts')
if (isMain) {
  const out = resolve('tests/fixtures/sample.epub')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, await buildFixtureEpub())
  console.log(`已生成 ${out}`)
}
```

- [ ] **Step 4: 运行测试确认通过并生成样本**

Run: `npm test && npm run fixture`
Expected: 测试全通过,终端打印「已生成 .../tests/fixtures/sample.epub」

- [ ] **Step 5: 让样本书不进版本库**

`.gitignore` 追加一行:

```
tests/fixtures/*.epub
```

样本由脚本确定性生成,不需要提交二进制文件。端到端测试运行前会自己生成。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "test: add deterministic fixture epub generator"
```

---

### Task 8: 范围 CFI 合成

**Files:**
- Create: `src/renderer/reader/cfi.ts`
- Test: `tests/unit/cfi.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `makeRangeCfi(startCfi: string, endCfi: string): string` — 把屏幕可见区域的起点 CFI 与终点 CFI 合成一个范围 CFI,供 `book.getRange()` 取出这一屏的文字

**为什么单独成文件:** epub.js 只给出 `location.start.cfi` 和 `location.end.cfi` 两个点,不直接给范围。取「当前页文字」必须先合成范围。这段逻辑是纯字符串运算,可以脱离浏览器单测,而 `engine.ts` 不能。

- [ ] **Step 1: 写失败的测试**

`tests/unit/cfi.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeRangeCfi } from '../../src/renderer/reader/cfi'

describe('范围 CFI 合成', () => {
  it('同一章内的两点合成带逗号的范围', () => {
    const r = makeRangeCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/8/1:12)')
    expect(r.startsWith('epubcfi(')).toBe(true)
    expect(r.endsWith(')')).toBe(true)
    expect(r.split(',').length).toBe(3)
  })

  it('公共前缀被提取到逗号前,不在两个分支里重复', () => {
    const r = makeRangeCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/8/1:12)')
    const [common] = r.split(',')
    expect(common).toContain('/6/4!')
    expect(common).toContain('/4/2')
  })

  it('起点和终点完全相同时仍返回合法的 epubcfi 字符串', () => {
    const same = 'epubcfi(/6/4!/4/2/2/1:0)'
    const r = makeRangeCfi(same, same)
    expect(r.startsWith('epubcfi(')).toBe(true)
    expect(r.endsWith(')')).toBe(true)
  })

  it('跨章节时不吞掉章节差异', () => {
    const r = makeRangeCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/6!/4/2/2/1:5)')
    expect(r).toContain('/6/4')
    expect(r).toContain('/6/6')
  })

  it('传入不是 epubcfi 的字符串时抛出可读的错误', () => {
    expect(() => makeRangeCfi('随便什么', 'epubcfi(/6/4!/4/2/2/1:0)')).toThrow(/CFI/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/cfi.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/renderer/reader/cfi"`

- [ ] **Step 3: 实现范围合成**

`src/renderer/reader/cfi.ts`:

```ts
interface Step {
  type: string
  index: number
  id: string | null
}

interface Part {
  steps: Step[]
  terminal: { offset: number | null; assertion: string | null } | null
}

function parseSegment(segment: string): Part {
  const steps: Step[] = []
  let terminal: Part['terminal'] = null
  for (const raw of segment.split('/')) {
    if (!raw) continue
    const colon = raw.indexOf(':')
    if (colon >= 0) {
      const index = Number(raw.slice(0, colon).split('[')[0])
      steps.push({ type: index % 2 === 0 ? 'element' : 'text', index, id: null })
      terminal = { offset: Number(raw.slice(colon + 1)), assertion: null }
      continue
    }
    const bracket = raw.indexOf('[')
    const index = Number(bracket >= 0 ? raw.slice(0, bracket) : raw)
    const id = bracket >= 0 ? raw.slice(bracket + 1, raw.indexOf(']')) : null
    steps.push({ type: index % 2 === 0 ? 'element' : 'text', index, id })
  }
  return { steps, terminal }
}

function stringifySteps(steps: Step[]): string {
  return steps.map((s) => `/${s.index}${s.id ? `[${s.id}]` : ''}`).join('')
}

function stringifyPart(part: Part): string {
  const body = stringifySteps(part.steps)
  if (part.terminal && part.terminal.offset !== null) return `${body}:${part.terminal.offset}`
  return body
}

function split(cfi: string): { base: string; part: Part } {
  const m = /^epubcfi\((.*)\)$/.exec(cfi.trim())
  if (!m) throw new Error(`不是合法的 CFI:${cfi}`)
  const inner = m[1]
  const bang = inner.indexOf('!')
  if (bang < 0) return { base: '', part: parseSegment(inner) }
  return { base: inner.slice(0, bang), part: parseSegment(inner.slice(bang + 1)) }
}

/**
 * 把起点 CFI 与终点 CFI 合成一个范围 CFI。
 * 形如 epubcfi(公共前缀,起点剩余部分,终点剩余部分)。
 * epub.js 的 book.getRange() 需要这种形式才能取出一段文字。
 */
export function makeRangeCfi(startCfi: string, endCfi: string): string {
  const a = split(startCfi)
  const b = split(endCfi)

  // 起止不在同一个章节文件里,无法提取公共路径,退化为整段各写一次
  if (a.base !== b.base) {
    return `epubcfi(${a.base}!${stringifyPart(a.part)},,${b.base}!${stringifyPart(b.part)})`
  }

  const common: Step[] = []
  const len = Math.min(a.part.steps.length, b.part.steps.length)
  for (let i = 0; i < len; i++) {
    const x = a.part.steps[i]
    const y = b.part.steps[i]
    if (x.index === y.index && x.id === y.id && i < len - 1) common.push(x)
    else break
  }

  const startRest: Part = { steps: a.part.steps.slice(common.length), terminal: a.part.terminal }
  const endRest: Part = { steps: b.part.steps.slice(common.length), terminal: b.part.terminal }
  const prefix = a.base ? `${a.base}!${stringifySteps(common)}` : stringifySteps(common)

  return `epubcfi(${prefix},${stringifyPart(startRest)},${stringifyPart(endRest)})`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS — 全部 37 个用例通过

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: compose range cfi from visible start and end points"
```

---

### Task 9: 渲染引擎封装

**Files:**
- Create: `src/renderer/reader/engine.ts`
- Create: `src/renderer/reader/types.ts`

**Interfaces:**
- Consumes: `makeRangeCfi`
- Produces:
  - `types.ts`:`VisibleRange`、`TocItem`、`ThemeName`、`OpenOptions`
  - `engine.ts`:`createEngine(container: HTMLElement): ReaderEngine`

```ts
export interface ReaderEngine {
  open(data: ArrayBuffer, opts: OpenOptions): Promise<void>
  display(target?: string): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  setSpread(on: boolean): Promise<void>
  setFontSize(px: number): void
  setTheme(name: ThemeName): void
  getVisible(): Promise<VisibleRange>
  toc(): TocItem[]
  currentCfi(): string | null
  exportLocations(): string | null
  onRelocated(cb: () => void): () => void
  destroy(): void
}
```

**本任务没有单元测试。** epub.js 的分页依赖真实浏览器排版,jsdom 里跑不出页。它的验证放在 Task 11 的端到端测试。本任务只交付可编译、接口明确的封装。

- [ ] **Step 1: 定义类型**

`src/renderer/reader/types.ts`:

```ts
export type ThemeName = 'light' | 'dark'

export interface TocItem {
  label: string
  href: string
  depth: number
}

export interface VisibleRange {
  /** 屏幕上当前可见的正文纯文本 */
  text: string
  startCfi: string
  endCfi: string
  rangeCfi: string
  /** 当前所在章节的文件路径 */
  chapterHref: string
  /** 当前章节标题,目录里查不到时为 null */
  chapterLabel: string | null
  /** 页码 = 位置索引 + 1,不随字号变化 */
  page: number
  totalPages: number
}

export interface OpenOptions {
  fontSize: number
  theme: ThemeName
  /** 上次存下的位置索引,有就直接用,免去重新计算 */
  savedLocations: string | null
}
```

- [ ] **Step 2: 实现引擎封装**

`src/renderer/reader/engine.ts`:

```ts
import ePub, { type Book, type Rendition } from 'epubjs'
import { makeRangeCfi } from './cfi'
import type { OpenOptions, ReaderEngine, ThemeName, TocItem, VisibleRange } from './types'

const THEMES: Record<ThemeName, Record<string, Record<string, string>>> = {
  light: {
    body: { color: '#1a1a1a', background: '#faf8f5' },
    a: { color: '#1a5fb4' }
  },
  dark: {
    body: { color: '#d6d3cd', background: '#1c1b19' },
    a: { color: '#7aa2f7' }
  }
}

/** 位置索引的切分粒度。数字越小页数越多、生成越慢。1000 字符约等于一屏中文。 */
const LOCATION_CHUNK = 1000

export function createEngine(container: HTMLElement): ReaderEngine {
  let book: Book | null = null
  let rendition: Rendition | null = null
  let toc: TocItem[] = []
  let listeners: (() => void)[] = []
  let locationsReady = false

  function flatToc(items: any[], depth: number, out: TocItem[]): void {
    for (const item of items) {
      out.push({ label: String(item.label ?? '').trim(), href: String(item.href ?? ''), depth })
      if (Array.isArray(item.subitems) && item.subitems.length > 0) {
        flatToc(item.subitems, depth + 1, out)
      }
    }
  }

  function notify(): void {
    for (const cb of listeners) cb()
  }

  return {
    async open(data: ArrayBuffer, opts: OpenOptions): Promise<void> {
      book = ePub(data)
      rendition = book.renderTo(container, {
        width: '100%',
        height: '100%',
        flow: 'paginated',
        spread: 'none',
        allowScriptedContent: false
      })
      rendition.themes.register('light', THEMES.light)
      rendition.themes.register('dark', THEMES.dark)
      rendition.themes.select(opts.theme)
      rendition.themes.fontSize(`${opts.fontSize}px`)

      await book.ready
      const nav = await book.loaded.navigation
      const items: TocItem[] = []
      flatToc(nav.toc as any[], 0, items)
      toc = items

      if (opts.savedLocations) {
        book.locations.load(opts.savedLocations)
        locationsReady = true
      } else {
        void book.locations.generate(LOCATION_CHUNK).then(() => {
          locationsReady = true
          notify()
        })
      }

      rendition.on('relocated', notify)
    },

    async display(target?: string): Promise<void> {
      if (!rendition) throw new Error('书还没打开')
      await rendition.display(target)
    },

    async next(): Promise<void> {
      await rendition?.next()
    },

    async prev(): Promise<void> {
      await rendition?.prev()
    },

    async setSpread(on: boolean): Promise<void> {
      if (!rendition) return
      rendition.spread(on ? 'auto' : 'none')
      // 切换后当前位置需要重新落位,否则可能停在半页
      const cfi = rendition.location?.start?.cfi
      if (cfi) await rendition.display(cfi)
    },

    setFontSize(px: number): void {
      rendition?.themes.fontSize(`${px}px`)
    },

    setTheme(name: ThemeName): void {
      rendition?.themes.select(name)
    },

    async getVisible(): Promise<VisibleRange> {
      if (!book || !rendition?.location) throw new Error('书还没打开')
      const { start, end } = rendition.location
      const rangeCfi = makeRangeCfi(start.cfi, end.cfi)

      let text = ''
      try {
        const range = await book.getRange(rangeCfi)
        text = range.toString().replace(/\s+/g, ' ').trim()
      } catch {
        // 跨章节等边界情况下范围取不出来,退回只取起点所在段落
        text = ''
      }

      const href = String(start.href ?? '')
      const entry = toc.find((t) => t.href === href || t.href.split('#')[0] === href)
      const page = locationsReady ? book.locations.locationFromCfi(start.cfi) + 1 : 0
      const totalPages = locationsReady ? book.locations.total : 0

      return {
        text,
        startCfi: start.cfi,
        endCfi: end.cfi,
        rangeCfi,
        chapterHref: href,
        chapterLabel: entry ? entry.label : null,
        page,
        totalPages
      }
    },

    toc(): TocItem[] {
      return toc
    },

    currentCfi(): string | null {
      return rendition?.location?.start?.cfi ?? null
    },

    exportLocations(): string | null {
      if (!book || !locationsReady) return null
      return book.locations.save()
    },

    onRelocated(cb: () => void): () => void {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((x) => x !== cb)
      }
    },

    destroy(): void {
      listeners = []
      rendition?.destroy()
      book?.destroy()
      rendition = null
      book = null
      toc = []
      locationsReady = false
    }
  }
}

export type { ReaderEngine } from './types'
```

- [ ] **Step 3: 把 ReaderEngine 接口补进类型文件**

在 `src/renderer/reader/types.ts` 末尾追加:

```ts
export interface ReaderEngine {
  open(data: ArrayBuffer, opts: OpenOptions): Promise<void>
  display(target?: string): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  setSpread(on: boolean): Promise<void>
  setFontSize(px: number): void
  setTheme(name: ThemeName): void
  getVisible(): Promise<VisibleRange>
  toc(): TocItem[]
  currentCfi(): string | null
  exportLocations(): string | null
  onRelocated(cb: () => void): () => void
  destroy(): void
}
```

- [ ] **Step 4: 装 epub.js 的类型并确认能编译**

Run: `npm run build`
Expected: 构建成功。epub.js 自带类型声明,不需要额外装类型包。若报 `location` 上的属性类型不全,在 `engine.ts` 里把 `rendition.location` 取出后断言为本文件定义的局部类型,不要改动 `types.ts` 里的对外接口。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: wrap epub.js behind a reader engine interface"
```

---

### Task 10: 书库界面与导入流程

**Files:**
- Create: `src/renderer/library/metadata.ts`
- Create: `src/renderer/library/LibraryView.tsx`
- Create: `src/renderer/styles/theme.css`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/main.tsx`

**Interfaces:**
- Consumes: `window.api` 全部方法
- Produces:
  - `extractMetadata(data: ArrayBuffer): Promise<{ title: string; author: string | null; coverBytes: number[] | null }>`
  - `<LibraryView onOpenBook={(book: BookRecord) => void} />`

- [ ] **Step 1: 实现元数据提取**

`src/renderer/library/metadata.ts`:

```ts
import ePub from 'epubjs'

async function blobToBytes(blob: Blob): Promise<number[]> {
  const buf = await blob.arrayBuffer()
  return Array.from(new Uint8Array(buf))
}

/**
 * 在渲染进程里解析 EPUB 元数据。
 * 放这里而不是主进程,是因为 epub.js 依赖浏览器的 XML 解析,
 * 主进程没有,再装一个解析器等于维护两套 EPUB 解析逻辑。
 */
export async function extractMetadata(data: ArrayBuffer): Promise<{
  title: string
  author: string | null
  coverBytes: number[] | null
}> {
  const book = ePub(data)
  try {
    await book.ready
    const meta = await book.loaded.metadata
    let coverBytes: number[] | null = null
    try {
      const url = await book.coverUrl()
      if (url) {
        const blob = await fetch(url).then((r) => r.blob())
        coverBytes = await blobToBytes(blob)
      }
    } catch {
      coverBytes = null
    }
    return {
      title: String(meta.title ?? '').trim(),
      author: String(meta.creator ?? '').trim() || null,
      coverBytes
    }
  } finally {
    book.destroy()
  }
}
```

- [ ] **Step 2: 写主题样式**

`src/renderer/styles/theme.css`:

```css
:root {
  --bg: #faf8f5;
  --bg-raised: #ffffff;
  --fg: #1a1a1a;
  --fg-muted: #6b6864;
  --border: #e2ded7;
  --accent: #1a5fb4;
  --danger: #b4231a;
  --radius: 8px;
}

:root[data-theme='dark'] {
  --bg: #1c1b19;
  --bg-raised: #26241f;
  --fg: #d6d3cd;
  --fg-muted: #918d86;
  --border: #3a3730;
  --accent: #7aa2f7;
  --danger: #e06c75;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  font-size: 14px;
  user-select: none;
}

button {
  font: inherit;
  color: var(--fg);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 14px;
  cursor: pointer;
}

button:hover {
  border-color: var(--accent);
}

.library {
  padding: 24px;
}

.library__bar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 20px;
}

.library__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 20px;
}

.book-card {
  cursor: pointer;
}

.book-card__cover {
  aspect-ratio: 2 / 3;
  width: 100%;
  object-fit: cover;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-raised);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  text-align: center;
  padding: 10px;
  overflow: hidden;
}

.book-card__title {
  margin-top: 8px;
  font-weight: 600;
  line-height: 1.35;
}

.book-card__author {
  color: var(--fg-muted);
  font-size: 12px;
}

.dropzone--active {
  outline: 2px dashed var(--accent);
  outline-offset: -12px;
}

.empty {
  color: var(--fg-muted);
  padding: 60px 0;
  text-align: center;
}
```

- [ ] **Step 3: 实现书库界面**

`src/renderer/library/LibraryView.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { BookRecord } from '@shared/types'
import { extractMetadata } from './metadata'

interface Props {
  onOpenBook: (book: BookRecord) => void
}

export default function LibraryView({ onOpenBook }: Props) {
  const [books, setBooks] = useState<BookRecord[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBooks(await window.api.listBooks())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return
      setError(null)
      try {
        const staged = await window.api.stageImport(paths)
        for (let i = 0; i < staged.length; i++) {
          setBusy(`正在导入 ${i + 1}/${staged.length}`)
          const file = staged[i]
          // 此刻还没入库,只能按库内文件路径读
          const bytes = await window.api.readStagedFile(file.filePath)
          const meta = await extractMetadata(bytes)
          await window.api.finishImport({
            id: file.id,
            filePath: file.filePath,
            sourcePath: paths[i],
            title: meta.title,
            author: meta.author,
            coverBytes: meta.coverBytes
          })
        }
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '导入失败')
      } finally {
        setBusy(null)
      }
    },
    [refresh]
  )

  const onPickFiles = useCallback(async () => {
    await importPaths(await window.api.pickEpubFiles())
  }, [importPaths])

  const onPickFolder = useCallback(async () => {
    const dir = await window.api.pickFolder()
    if (!dir) return
    setBusy('正在扫描文件夹')
    try {
      const found = await window.api.scanFolder(dir)
      if (found.length === 0) {
        setError('这个文件夹里没有发现未导入的 EPUB')
        return
      }
      await importPaths(found)
    } catch (e) {
      setError(e instanceof Error ? e.message : '扫描失败')
    } finally {
      setBusy(null)
    }
  }, [importPaths])

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const paths: string[] = []
      for (const file of Array.from(e.dataTransfer.files)) {
        const path = window.api.pathForFile(file)
        if (path && path.toLowerCase().endsWith('.epub')) paths.push(path)
      }
      if (paths.length === 0) {
        setError('拖进来的文件里没有 EPUB')
        return
      }
      await importPaths(paths)
    },
    [importPaths]
  )

  return (
    <div
      className={`library${dragging ? ' dropzone--active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-testid="library"
    >
      <div className="library__bar">
        <button onClick={onPickFiles} data-testid="pick-files">
          添加 EPUB
        </button>
        <button onClick={onPickFolder} data-testid="pick-folder">
          扫描文件夹
        </button>
        {busy && <span className="book-card__author">{busy}…</span>}
        {error && <span style={{ color: 'var(--danger)' }}>{error}</span>}
      </div>

      {books.length === 0 ? (
        <p className="empty">书架是空的。把 EPUB 文件拖进这个窗口,或者点上面的按钮。</p>
      ) : (
        <div className="library__grid">
          {books.map((book) => (
            <div
              key={book.id}
              className="book-card"
              data-testid="book-card"
              onClick={() => onOpenBook(book)}
            >
              <div className="book-card__cover">
                {book.coverPath ? (
                  <img
                    src={`file://${book.coverPath}`}
                    alt={book.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  book.title
                )}
              </div>
              <div className="book-card__title">{book.title}</div>
              <div className="book-card__author">{book.author ?? '佚名'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 补上取拖拽文件路径的桥接方法**

Electron 从 32 起,渲染层拿不到 `File.path`,必须经 `webUtils.getPathForFile`。

`src/preload/index.ts` 顶部 import 改为:

```ts
import { contextBridge, ipcRenderer, webUtils } from 'electron'
```

在 `api` 对象里加一项:

```ts
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
```

- [ ] **Step 5: 接上 App 与样式**

`src/renderer/main.tsx` 顶部加一行:

```tsx
import './styles/theme.css'
```

`src/renderer/App.tsx` 整个替换为:

```tsx
import { useState } from 'react'
import type { BookRecord } from '@shared/types'
import LibraryView from './library/LibraryView'

export default function App() {
  const [reading, setReading] = useState<BookRecord | null>(null)

  if (reading) {
    return (
      <div style={{ padding: 24 }}>
        <button onClick={() => setReading(null)}>← 回到书架</button>
        <h2>{reading.title}</h2>
      </div>
    )
  }

  return <LibraryView onOpenBook={setReading} />
}
```

阅读界面在下一个任务实现,这里先放一个占位,保证书库这一环可以单独验收。

- [ ] **Step 6: 手动验收**

Run: `npm run dev`

依次确认:
1. 窗口显示「书架是空的」提示
2. 点「添加 EPUB」,选中 `tests/fixtures/sample.epub`,导入后出现一张卡片,书名「测试之书」,作者「测试作者」
3. 关掉应用再 `npm run dev`,卡片还在
4. 把另一个 epub 文件拖进窗口,能导入
5. 点卡片进入占位页,点「← 回到书架」能返回

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: add library view with drag, file picker, and folder scan import"
```

---

### Task 11: 阅读界面

**Files:**
- Create: `src/renderer/reader/ReaderView.tsx`
- Create: `src/renderer/reader/TocPanel.tsx`
- Modify: `src/renderer/styles/theme.css`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `createEngine`、`VisibleRange`、`TocItem`、`window.api`
- Produces: `<ReaderView book={BookRecord} onBack={() => void} />`

**本任务交付的行为:** 开书、翻页(按钮与左右方向键)、目录跳转、字号加减、浅深主题切换、页码显示、退出时与翻页时保存阅读位置、重新打开回到上次位置。

- [ ] **Step 1: 实现目录面板**

`src/renderer/reader/TocPanel.tsx`:

```tsx
import type { TocItem } from './types'

interface Props {
  items: TocItem[]
  currentHref: string
  onJump: (href: string) => void
  onClose: () => void
}

export default function TocPanel({ items, currentHref, onJump, onClose }: Props) {
  return (
    <div className="toc" data-testid="toc">
      <div className="toc__head">
        <strong>目录</strong>
        <button onClick={onClose}>关闭</button>
      </div>
      <ul className="toc__list">
        {items.map((item, i) => {
          const active = item.href.split('#')[0] === currentHref.split('#')[0]
          return (
            <li key={`${item.href}-${i}`}>
              <button
                className={`toc__item${active ? ' toc__item--active' : ''}`}
                style={{ paddingLeft: 10 + item.depth * 16 }}
                onClick={() => onJump(item.href)}
              >
                {item.label || '(无标题)'}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: 实现阅读界面**

`src/renderer/reader/ReaderView.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookRecord } from '@shared/types'
import TocPanel from './TocPanel'
import { createEngine } from './engine'
import type { ReaderEngine, ThemeName, TocItem, VisibleRange } from './types'

const FONT_MIN = 14
const FONT_MAX = 28

interface Props {
  book: BookRecord
  onBack: () => void
}

export default function ReaderView({ book, onBack }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<ReaderEngine | null>(null)
  const [visible, setVisible] = useState<VisibleRange | null>(null)
  const [toc, setToc] = useState<TocItem[]>([])
  const [showToc, setShowToc] = useState(false)
  const [fontSize, setFontSize] = useState(18)
  const [theme, setTheme] = useState<ThemeName>('light')
  const [error, setError] = useState<string | null>(null)

  // 开书:读设置 → 读文件 → 渲染 → 跳到上次位置
  useEffect(() => {
    let cancelled = false
    let engine: ReaderEngine | null = null

    async function boot(): Promise<void> {
      if (!hostRef.current) return
      try {
        const savedFont = Number((await window.api.getSetting('fontSize')) ?? 18)
        const savedTheme = ((await window.api.getSetting('theme')) ?? 'light') as ThemeName
        const savedLocations = await window.api.getLocations(book.id)
        const data = await window.api.readBookFile(book.id)
        if (cancelled) return

        engine = createEngine(hostRef.current)
        engineRef.current = engine
        setFontSize(Number.isFinite(savedFont) ? savedFont : 18)
        setTheme(savedTheme)
        document.documentElement.dataset.theme = savedTheme

        await engine.open(data, {
          fontSize: Number.isFinite(savedFont) ? savedFont : 18,
          theme: savedTheme,
          savedLocations
        })
        setToc(engine.toc())
        await engine.display(book.lastReadCfi ?? undefined)
        if (cancelled) return

        engine.onRelocated(() => {
          void engine!.getVisible().then((v) => {
            if (!cancelled) setVisible(v)
          })
          const cfi = engine!.currentCfi()
          if (cfi) void window.api.saveProgress(book.id, cfi)
        })

        setVisible(await engine.getVisible())

        // 位置索引首次生成完要落盘,下次开书省去重算
        if (!savedLocations) {
          const poll = setInterval(() => {
            const json = engine?.exportLocations()
            if (json) {
              clearInterval(poll)
              void window.api.saveLocations(book.id, json)
            }
          }, 800)
          setTimeout(() => clearInterval(poll), 60000)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '这本书打不开')
      }
    }

    void boot()
    return () => {
      cancelled = true
      engine?.destroy()
      engineRef.current = null
    }
  }, [book])

  const next = useCallback(() => void engineRef.current?.next(), [])
  const prev = useCallback(() => void engineRef.current?.prev(), [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') next()
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev])

  const changeFont = useCallback((delta: number) => {
    setFontSize((old) => {
      const size = Math.min(FONT_MAX, Math.max(FONT_MIN, old + delta))
      engineRef.current?.setFontSize(size)
      void window.api.setSetting('fontSize', String(size))
      return size
    })
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((old) => {
      const nextTheme: ThemeName = old === 'light' ? 'dark' : 'light'
      engineRef.current?.setTheme(nextTheme)
      document.documentElement.dataset.theme = nextTheme
      void window.api.setSetting('theme', nextTheme)
      return nextTheme
    })
  }, [])

  const jump = useCallback((href: string) => {
    setShowToc(false)
    void engineRef.current?.display(href)
  }, [])

  if (error) {
    return (
      <div className="reader__error">
        <p>{error}</p>
        <button onClick={onBack}>← 回到书架</button>
      </div>
    )
  }

  return (
    <div className="reader">
      <header className="reader__bar">
        <button onClick={onBack}>← 书架</button>
        <button onClick={() => setShowToc((v) => !v)} data-testid="toggle-toc">
          目录
        </button>
        <span className="reader__title">{book.title}</span>
        <span className="reader__spacer" />
        <button onClick={() => changeFont(-2)} aria-label="缩小字号">
          A−
        </button>
        <button onClick={() => changeFont(2)} aria-label="放大字号">
          A+
        </button>
        <button onClick={toggleTheme}>{theme === 'light' ? '夜间' : '日间'}</button>
      </header>

      <div className="reader__body">
        {showToc && (
          <TocPanel
            items={toc}
            currentHref={visible?.chapterHref ?? ''}
            onJump={jump}
            onClose={() => setShowToc(false)}
          />
        )}
        <button className="reader__nav reader__nav--prev" onClick={prev} aria-label="上一页">
          ‹
        </button>
        <div className="reader__page" ref={hostRef} data-testid="reader-page" />
        <button className="reader__nav reader__nav--next" onClick={next} aria-label="下一页">
          ›
        </button>
      </div>

      <footer className="reader__foot" data-testid="reader-foot">
        <span>{visible?.chapterLabel ?? ''}</span>
        <span data-testid="page-indicator">
          {visible && visible.totalPages > 0
            ? `第 ${visible.page} / ${visible.totalPages} 页`
            : '正在计算页码…'}
        </span>
      </footer>
    </div>
  )
}
```

- [ ] **Step 3: 补阅读界面样式**

`src/renderer/styles/theme.css` 末尾追加:

```css
.reader {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.reader__bar,
.reader__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
}

.reader__foot {
  border-bottom: none;
  border-top: 1px solid var(--border);
  justify-content: space-between;
  color: var(--fg-muted);
  font-size: 12px;
}

.reader__title {
  font-weight: 600;
  margin-left: 6px;
}

.reader__spacer {
  flex: 1;
}

.reader__body {
  flex: 1;
  display: flex;
  align-items: stretch;
  min-height: 0;
  position: relative;
}

.reader__page {
  flex: 1;
  min-width: 0;
  user-select: text;
}

.reader__nav {
  border: none;
  background: transparent;
  width: 48px;
  font-size: 26px;
  color: var(--fg-muted);
}

.reader__nav:hover {
  background: var(--bg-raised);
  color: var(--fg);
}

.reader__error {
  padding: 60px;
  text-align: center;
  color: var(--danger);
}

.toc {
  width: 260px;
  border-right: 1px solid var(--border);
  background: var(--bg-raised);
  overflow-y: auto;
  flex-shrink: 0;
}

.toc__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.toc__list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
}

.toc__item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  border-radius: 0;
  padding: 7px 10px;
  line-height: 1.4;
}

.toc__item--active {
  color: var(--accent);
  font-weight: 600;
}
```

- [ ] **Step 4: 接进 App**

`src/renderer/App.tsx` 整个替换为:

```tsx
import { useState } from 'react'
import type { BookRecord } from '@shared/types'
import LibraryView from './library/LibraryView'
import ReaderView from './reader/ReaderView'

export default function App() {
  const [reading, setReading] = useState<BookRecord | null>(null)

  if (reading) return <ReaderView book={reading} onBack={() => setReading(null)} />
  return <LibraryView onOpenBook={setReading} />
}
```

- [ ] **Step 5: 手动验收**

Run: `npm run dev`

依次确认:
1. 点书进入阅读界面,能看到正文,不是空白
2. 按右方向键翻页,底部页码递增;左方向键能翻回去
3. 点「目录」,列出三章,点第二章能跳过去,底部章节名变成「第二章 那个夏天」
4. 点 A+ 两次,字号变大,底部页码**不变**(页码按字数算,与字号无关)
5. 点「夜间」,正文和界面同时变深色
6. 退出到书架再进来,回到刚才那一页
7. 完全关掉应用重开,字号、主题、阅读位置都还在

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: add reading view with pagination, toc, font size, and theme"
```

---

### Task 12: 端到端冒烟测试

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/reader.spec.ts`
- Create: `tests/e2e/helpers.ts`
- Modify: `package.json`
- Modify: `src/main/ipc.ts`

**Interfaces:**
- Consumes: 打包产物 `out/main/index.js`、样本书 `tests/fixtures/sample.epub`
- Produces: `npm run test:e2e` 跑通「导入 → 开书 → 翻页 → 目录跳转 → 重开记住位置」

**为什么要给主进程开一个测试专用通道:** 系统文件选择框弹出来后 Playwright 点不到。加一个只在设置了环境变量时才注册的 IPC 通道,直接传路径进来,绕开对话框。

- [ ] **Step 1: 给主进程加测试通道**

`src/main/ipc.ts` 的 `registerIpc()` 函数末尾追加:

```ts
  // 仅端到端测试使用:绕开系统文件选择框直接传入路径
  if (process.env.READER_E2E === '1') {
    ipcMain.handle('test:importPaths', async (_e, paths: string[]): Promise<string[]> => paths)
  }
```

`src/preload/index.ts` 的 `api` 对象里追加:

```ts
  testImportPaths: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('test:importPaths', paths),
```

`src/renderer/library/LibraryView.tsx` 里,把 `onPickFiles` 改为:

```tsx
  const onPickFiles = useCallback(async () => {
    const injected = (window as unknown as { __E2E_FILES__?: string[] }).__E2E_FILES__
    const paths = injected ?? (await window.api.pickEpubFiles())
    await importPaths(paths)
  }, [importPaths])
```

测试把路径写进 `window.__E2E_FILES__`,点同一个按钮即可走完整导入流程。

- [ ] **Step 2: 写 Playwright 配置**

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']]
})
```

- [ ] **Step 3: 写测试辅助**

`tests/e2e/helpers.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { buildFixtureEpub } from '../../scripts/make-fixture-epub'

export interface Harness {
  app: ElectronApplication
  page: Page
  userData: string
  fixturePath: string
}

/** 每次启动都用全新的数据目录,测试之间互不影响。传入 userData 可复用上一次的数据。 */
export async function launch(userData?: string): Promise<Harness> {
  const dir = userData ?? mkdtempSync(join(tmpdir(), 'reader-e2e-'))
  const workDir = mkdtempSync(join(tmpdir(), 'reader-e2e-src-'))
  const fixturePath = join(workDir, '测试之书.epub')
  writeFileSync(fixturePath, await buildFixtureEpub())

  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, READER_USER_DATA: dir, READER_E2E: '1', NODE_ENV: 'test' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData: dir, fixturePath }
}

export async function importFixture(h: Harness): Promise<void> {
  await h.page.evaluate((p) => {
    ;(window as unknown as { __E2E_FILES__: string[] }).__E2E_FILES__ = [p]
  }, h.fixturePath)
  await h.page.getByTestId('pick-files').click()
  await h.page.getByTestId('book-card').first().waitFor({ timeout: 30_000 })
}
```

- [ ] **Step 4: 写端到端测试**

`tests/e2e/reader.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { importFixture, launch, type Harness } from './helpers'

test('导入一本书后书架上能看到书名和作者', async () => {
  const h: Harness = await launch()
  await importFixture(h)
  await expect(h.page.getByText('测试之书')).toBeVisible()
  await expect(h.page.getByText('测试作者')).toBeVisible()
  await h.app.close()
})

test('打开书能看到正文,右方向键能翻页且页码递增', async () => {
  const h = await launch()
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()

  const indicator = h.page.getByTestId('page-indicator')
  await expect(indicator).toContainText('页', { timeout: 40_000 })
  await expect(indicator).not.toContainText('正在计算', { timeout: 60_000 })

  const before = await indicator.textContent()
  await h.page.keyboard.press('ArrowRight')
  await expect(indicator).not.toHaveText(before!, { timeout: 15_000 })

  await h.page.keyboard.press('ArrowLeft')
  await expect(indicator).toHaveText(before!, { timeout: 15_000 })
  await h.app.close()
})

test('目录列出三章,点第二章后底部章节名跟着变', async () => {
  const h = await launch()
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()

  await h.page.getByTestId('toggle-toc').click()
  const toc = h.page.getByTestId('toc')
  await expect(toc.getByText('第一章 开端')).toBeVisible()
  await expect(toc.getByText('第三章 归途')).toBeVisible()

  await toc.getByText('第二章 那个夏天').click()
  await expect(h.page.getByTestId('reader-foot')).toContainText('第二章 那个夏天', {
    timeout: 20_000
  })
  await h.app.close()
})

test('关掉应用重开,回到上次读到的位置', async () => {
  const first = await launch()
  await importFixture(first)
  await first.page.getByTestId('book-card').first().click()
  await first.page.getByTestId('reader-page').waitFor()
  const indicator = first.page.getByTestId('page-indicator')
  await expect(indicator).not.toContainText('正在计算', { timeout: 60_000 })

  for (let i = 0; i < 5; i++) await first.page.keyboard.press('ArrowRight')
  const stopped = await indicator.textContent()
  await first.page.waitForTimeout(1500)
  await first.app.close()

  const second = await launch(first.userData)
  await second.page.getByTestId('book-card').first().click()
  await expect(second.page.getByTestId('page-indicator')).toHaveText(stopped!, {
    timeout: 60_000
  })
  await second.app.close()
})
```

- [ ] **Step 5: 运行端到端测试**

Run: `npx playwright install chromium && npm run test:e2e`
Expected: 4 个用例全部通过

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "test: add end-to-end smoke tests for import, reading, and progress"
```

---

### Task 13: 打包、持续集成与说明文档

**Files:**
- Create: `electron-builder.yml`
- Create: `build/entitlements.mac.plist`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `README.md`
- Create: `LICENSE`
- Modify: `package.json`

**Interfaces:**
- Consumes: `npm run build` 的产物
- Produces: `npm run dist` 在本机出安装包;打 `v*` 标签后 GitHub Actions 自动出 macOS 的 .dmg(Intel 与 Apple 芯片各一)和 Windows 的 .exe 并发布 Release

- [ ] **Step 1: 写 electron-builder 配置**

`electron-builder.yml`:

```yaml
appId: com.github.aireader
productName: AI 阅读器
directories:
  output: release
  buildResources: build
files:
  - out/**/*
  - package.json
mac:
  category: public.app-category.book
  target:
    - target: dmg
      arch: [x64, arm64]
  # 不做签名与公证。用户首次打开需右键→打开,README 有说明。
  identity: null
  hardenedRuntime: false
  entitlements: build/entitlements.mac.plist
win:
  target:
    - target: nsis
      arch: [x64]
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  artifactName: ${productName}-${version}-setup.${ext}
```

`build/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
  </dict>
</plist>
```

- [ ] **Step 2: 写持续集成**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.13'
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test
```

端到端测试需要图形环境,不进常规 CI,由开发者本地运行。

- [ ] **Step 3: 写发布流程**

`.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.13'
          cache: npm
      - run: npm ci
      - run: npm run dist
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            release/*.dmg
            release/*.exe
          draft: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: 写 README**

`README.md`:

````markdown
# AI 阅读器

带 AI 对话侧边栏的 EPUB 桌面阅读器。阅读时可以随时向 AI 提问,AI 自动知道你在读哪本书、读到哪一页、这一页写了什么。

## 下载安装

到 [Releases](../../releases) 页下载对应系统的安装包。

本项目未购买代码签名证书,首次打开需要手动放行一次。

### macOS

下载 `.dmg`,拖进「应用程序」,然后**右键点击应用图标,选「打开」**,在弹窗里再点一次「打开」。只需做这一次。

若提示「已损坏,无法打开」,在终端执行:

```bash
xattr -cr "/Applications/AI 阅读器.app"
```

### Windows

下载 `.exe` 运行。若出现蓝色的「Windows 已保护你的电脑」,点「更多信息」→「仍要运行」。

## 使用

1. 把 EPUB 文件拖进窗口,或点「添加 EPUB」,或点「扫描文件夹」批量导入
2. 点书的封面开始阅读
3. 左右方向键翻页

导入的书会复制一份到应用自己的数据目录,之后删除或移动原文件都不影响阅读。

## 从源码运行

需要 Node 22.13 或更高版本。

```bash
npm install
npm run dev
```

其他命令:

```bash
npm test          # 单元测试
npm run test:e2e  # 端到端测试(需要图形环境)
npm run dist      # 打包出本机平台的安装包
```

## 许可

MIT
````

- [ ] **Step 5: 写许可文件**

`LICENSE`(把 `<版权人>` 换成仓库所有者的名字):

```
MIT License

Copyright (c) 2026 <版权人>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

并在 `package.json` 里加一行 `"license": "MIT",`。

- [ ] **Step 6: 本机打包验证**

Run: `npm run dist`
Expected: `release/` 目录下出现本机平台的安装包。macOS 上是两个 `.dmg`,Windows 上是一个 `-setup.exe`。安装后能正常启动、导入书、阅读。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "chore: add packaging, ci, release workflow, and readme"
```

---

## 计划一完成标准

全部跑通才算完成:

```bash
npm run build     # 类型检查与构建无错
npm test          # 单元测试全绿
npm run test:e2e  # 端到端 4 个用例全绿
npm run dist      # 本机安装包产出成功
```

并且手工确认:安装后的应用能导入 EPUB、能阅读、能翻页、能跳目录、能改字号和主题、重开记得上次读到哪。

## 与计划二的交接

计划二(AI 对话层)会直接消费以下已定型的接口,不再改动:

- `VisibleRange`:`text` / `startCfi` / `endCfi` / `rangeCfi` / `chapterHref` / `chapterLabel` / `page` / `totalPages`
- `ReaderEngine`:`getVisible()` / `setSpread(on)` / `onRelocated(cb)` / `currentCfi()` / `toc()`
- `window.api` 的设置读写:`getSetting(key)` / `setSetting(key, value)`
- 数据库的建表位置:`src/main/db/index.ts` 的 `SCHEMA` 常量

计划二新增的内容:`conversations` 与 `messages` 两张表、`secrets` 模块(API key 加密存储)、`llm` 模块(流式请求与错误分类)、`context` 模块(上下文拼装与四级裁剪)、`selection` 模块(划选高亮与点击取消)、侧边栏界面、跨页合并。
