import { Book } from 'epubjs'

/**
 * 在渲染进程里解析 EPUB 元数据。
 * 放这里而不是主进程,是因为 epub.js 依赖浏览器的 XML 解析,
 * 主进程没有,再装一个解析器等于维护两套 EPUB 解析逻辑。
 *
 * 注意(违反全项目约束的已知偏差):计划里写的是
 * "src/renderer/reader/engine.ts 是全项目唯一 import epub.js 的文件",
 * 本文件违反了这一条。任务书(task-10-brief.md)明确要求这个文件长这样,
 * 而这条约束显然是针对分页引擎写的——元数据提取(标题/作者/封面)跟分页
 * 渲染是两回事,但都得靠 epub.js 解析 EPUB 内部的 XML/OPF,主进程没有
 * DOM/XML 解析器,重新实现一遍解析逻辑代价远大于放宽这一条约束。
 * 这个矛盾已经按指示如实记录,交由上级裁决,这里不擅自更改计划文件。
 */
export async function extractMetadata(data: ArrayBuffer): Promise<{
  title: string
  author: string | null
  coverBytes: ArrayBuffer | null
}> {
  const book = new Book({ replacements: 'none', requestMethod: async () => { throw new Error('元数据解析不允许访问网络') } })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('电子书解析超时，请检查 EPUB 文件')), 15000)
  })
  try {
    // Explicit open rejects on bad containers; constructor + ready alone swallows that error.
    await Promise.race([book.open(data).then(() => book.ready), timeout])
    const meta = await Promise.race([book.loaded.metadata, timeout])
    let coverBytes: ArrayBuffer | null = null
    try {
      const url = await Promise.race([book.coverUrl(), timeout])
      if (url?.startsWith('blob:')) {
        const blob = await Promise.race([fetch(url).then((r) => r.blob()), timeout])
        if (blob.size > 5 * 1024 * 1024) throw new Error('封面过大')
        coverBytes = await Promise.race([blob.arrayBuffer(), timeout])
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
    clearTimeout(timer)
    book.destroy()
  }
}
