interface Step {
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
      steps.push({ index, id: null })
      terminal = { offset: Number(raw.slice(colon + 1)), assertion: null }
      continue
    }
    const bracket = raw.indexOf('[')
    const index = Number(bracket >= 0 ? raw.slice(0, bracket) : raw)
    const id = bracket >= 0 ? raw.slice(bracket + 1, raw.indexOf(']', bracket)) : null
    steps.push({ index, id })
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
  if (bang < 0) throw new Error('CFI 缺少章节分隔符:' + cfi)
  return { base: inner.slice(0, bang), part: parseSegment(inner.slice(bang + 1)) }
}

/**
 * 比较两个 Part 的先后顺序:先按步骤序号逐级比较,序号全部相同时路径短的排在前面,
 * 路径也完全相同时按字符偏移比较(缺失的偏移当作 0)。
 * 返回负数表示 a 在 b 之前,正数表示 a 在 b 之后,0 表示相同。
 */
function comparePart(a: Part, b: Part): number {
  const len = Math.min(a.steps.length, b.steps.length)
  for (let i = 0; i < len; i++) {
    if (a.steps[i].index !== b.steps[i].index) return a.steps[i].index - b.steps[i].index
  }
  if (a.steps.length !== b.steps.length) return a.steps.length - b.steps.length
  const aOffset = a.terminal?.offset ?? 0
  const bOffset = b.terminal?.offset ?? 0
  return aOffset - bOffset
}

/**
 * 把起点 CFI 与终点 CFI 合成一个范围 CFI。
 * 形如 epubcfi(公共前缀,起点剩余部分,终点剩余部分)。
 * epub.js 的 book.getRange() 需要这种形式才能取出一段文字。
 */
export function makeRangeCfi(startCfi: string, endCfi: string): string {
  let a = split(startCfi)
  let b = split(endCfi)

  // 范围标记无法跨越两个章节文档表达,与其生成一个会被解析器误读的畸形标记,不如直接失败
  if (a.base !== b.base) {
    throw new Error('起止位置不在同一章节,无法合成范围')
  }

  // 渲染库偶尔会把起止两个标记的顺序报反,这里做容错:排序不对就交换,而不是抛错丢页面文字
  if (comparePart(a.part, b.part) > 0) {
    const tmp = a
    a = b
    b = tmp
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
