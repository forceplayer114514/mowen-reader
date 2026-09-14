interface Step {
  index: number
  id: string | null
}

interface Part {
  steps: Step[]
  terminal: { offset: number | null; assertion: string | null } | null
}

/**
 * 从某个 raw 片段里 "[...]" 断言的起始位置(bracket,指向左方括号本身)开始,
 * 找到与之配对的右方括号的下标。CFI 的转义规则是 "^" 转义紧跟着的下一个字符,
 * 所以扫描时遇到 "^" 要连同它转义的那个字符一起跳过——不能把被转义的 "]"
 * 当成断言的结束,比如 "cha^]p]" 里第一个 "]" 是转义出来的字面量,真正的
 * 结束括号是最后那个。
 */
function findAssertionEnd(raw: string, bracket: number): number {
  let i = bracket + 1
  while (i < raw.length) {
    if (raw[i] === '^') {
      i += 2 // 跳过 ^ 本身和它转义的下一个字符,那个字符不能被当成结束的 ]
      continue
    }
    if (raw[i] === ']') return i
    i++
  }
  throw new Error(`CFI 断言缺少闭合的 ]:${raw}`)
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
    const id = bracket >= 0 ? raw.slice(bracket + 1, findAssertionEnd(raw, bracket)) : null
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

/** 返回 CFI 的章节包路径；不暴露章节标题这种可重复的展示字段。 */
export function cfiChapterKey(cfi: string): string {
  const steps = baseSteps(split(cfi).base)
  if (steps.some((step) => !Number.isSafeInteger(step))) throw new Error(`CFI 章节路径无效:${cfi}`)
  return steps.join('/')
}

/**
 * 比较两个 Part 的先后顺序:先按步骤序号逐级比较,序号全部相同时路径短的排在前面,
 * 路径也完全相同时按字符偏移比较。
 *
 * 缺失偏移量(没有冒号,比如纯粹指向一个元素节点而不是文本节点里的某个字符位置)
 * 不能当成偏移量 0 处理:两者是不同的位置形状,如果都当 0 看待,一个带 ":0"、
 * 另一个完全没写偏移量的两个标记会被判定成"相同位置",遇到需要纠正顺序的场景
 * (见 makeRangeCfi 里对调换过的起止点做的容错)就会被漏掉,不会被交换。
 * 这里让"没有偏移量"在数值上恒小于任何写出来的偏移量(包括显式的 0),
 * 用 -1 当哨兵值——偏移量本身不会是负数,所以不会和真实值撞上。
 *
 * 返回负数表示 a 在 b 之前,正数表示 a 在 b 之后,0 表示相同。
 */
function comparePart(a: Part, b: Part): number {
  const len = Math.min(a.steps.length, b.steps.length)
  for (let i = 0; i < len; i++) {
    if (a.steps[i].index !== b.steps[i].index) return a.steps[i].index - b.steps[i].index
  }
  if (a.steps.length !== b.steps.length) return a.steps.length - b.steps.length
  const aOffset = a.terminal?.offset ?? -1
  const bOffset = b.terminal?.offset ?? -1
  return aOffset - bOffset
}

/**
 * 比较同一章节内两个 CFI 标记的先后顺序,供下一阶段(对话内容的定位锚点)复用。
 *
 * 只解析 "!" 之后、代表章节内位置的那部分——不检查、也不知道两个 CFI 的章节前缀
 * (base,"!" 之前的部分)是否相同。两个不同章节的 CFI 传进来也不会报错,只会
 * 拿章节内的步骤/偏移比出一个没有意义的顺序,调用方必须自己先确认过章节相同
 * (比如比较 base 字符串,或者更可靠地比较 spine 索引)再调用这个函数。
 *
 * 返回负数表示 cfiA 在 cfiB 之前,正数表示 cfiA 在 cfiB 之后,0 表示相同位置。
 */
export function compareCfiPositions(cfiA: string, cfiB: string): number {
  const a = split(cfiA)
  const b = split(cfiB)
  return comparePart(a.part, b.part)
}

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
 * 与 compareCfiPositions 的区别有两处:一是它不要求两个 CFI 在同一章节,
 * 会先比较 base(章节路径);二是缺失的字符偏移在这里按 0 处理,视为与显式的
 * ":0" 相同位置——这与 compareCfiPositions 的语义**不同**(compareCfiPositions
 * 特意让缺失偏移恒小于任何显式偏移包括 0,是为了给 makeRangeCfi 的起止点纠错
 * 提供可交换的依据),所以这里不能直接委托给 compareCfiPositions,而是复用同一套
 * "逐项比较数字列表、再比长度"的逻辑(compareNumberLists)自己比较章节内路径,
 * 最后再用"缺失按 0 处理"的语义比较字符偏移。
 */
export function compareCfi(a: string, b: string): number {
  const left = split(a)
  const right = split(b)
  const byChapter = compareNumberLists(baseSteps(left.base), baseSteps(right.base))
  if (byChapter !== 0) return byChapter
  const byPath = compareNumberLists(
    left.part.steps.map((s) => s.index),
    right.part.steps.map((s) => s.index)
  )
  if (byPath !== 0) return byPath
  const aOffset = left.part.terminal?.offset ?? 0
  const bOffset = right.part.terminal?.offset ?? 0
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
