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
