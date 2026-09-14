import ePub, { type Book, type Contents, type NavItem, type Rendition } from 'epubjs'
import { makeRangeCfi } from './cfi'
import { normalizeChapterHref, resolveNavigationHref } from './href'
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

/**
 * 划选高亮的配色。epub.js 的高亮不是给文字加背景色,而是用 marks-pane 在正文上面
 * 盖一层 SVG 矩形(见 node_modules/epubjs/src/managers/views/iframe.js 的 highlight(),
 * 它把这里给的键值原样合并进矩形的属性),所以写的是 fill 而不是 background。
 * 两套主题必须分开配:浅色主题用正片叠底,让底下的黑字照样透出来;深色主题不能沿用,
 * 正片叠底只会越叠越黑,一块暗色盖在暗背景上等于没画,所以换成滤色往亮里叠。
 */
const HIGHLIGHT_STYLES: Record<ThemeName, Record<string, string>> = {
  light: { fill: '#f2c14e', 'fill-opacity': '0.45', 'mix-blend-mode': 'multiply' },
  dark: { fill: '#7aa2f7', 'fill-opacity': '0.38', 'mix-blend-mode': 'screen' }
}

/** 位置索引的切分粒度。数字越小页数越多、生成越慢。1000 字符约等于一屏中文。 */
const LOCATION_CHUNK = 1000

/**
 * epub.js 的类型声明里 Locations.locationFromCfi() 返回值标成了 DOM 的 Location 类型,
 * Locations.total 字段又完全没声明,两处都是类型包本身的疏漏(运行时其实就是 number)。
 * 这里declare 一个只描述我们用到的字段的局部接口,把 book.locations 断言过去,
 * 而不是放宽 types.ts 里对外的类型。
 */
interface LocationsWithTotal {
  total: number
  locationFromCfi(cfi: string): number
}

export function createEngine(container: HTMLElement): ReaderEngine {
  let book: Book | null = null
  let rendition: Rendition | null = null
  let toc: TocItem[] = []
  // spine 里各章节被 epub.js 解析后的、真正用来查找章节的路径(相对 OPF 目录),
  // 供 display() 把目录/外部传入的原始 href 归一化匹配回这个列表,见下面
  // resolveDisplayTarget() 的注释。
  let spineHrefs: string[] = []
  let listeners: (() => void)[] = []
  let keyListeners: ((key: string) => void)[] = []
  let selectionListeners: ((cfiRange: string, text: string) => void)[] = []
  // 当前这本书上加过的高亮:范围 -> 点击它时要回调的函数。自己记一份,是因为
  // clearHighlights() 和换主题重画都要逐个范围操作,而 epub.js 的 Annotations
  // 只把它们塞在 _annotations 这类私有字段里(见 node_modules/epubjs/src/annotations.js),
  // 去翻它的内部结构等于把自己钉死在某个版本的实现细节上。
  // 记的是回调而不只是范围字符串:换主题时要按新配色把同一段重新画一遍,
  // 重画就得把原来的点击回调原样再传进去,否则重画完的高亮点了没反应。
  const highlights = new Map<string, () => void>()
  // 该从 epub.js 那边摘掉、但当时一个章节视图都没渲染出来所以没敢摘的范围。
  // 见 hasRenderedViews() 的注释:那种时候摘会把 epub.js 自己的两张表弄成不一致。
  // 等下一次有视图渲染出来,syncHighlights() 会把这里欠着的一并补掉。
  const pendingRemovals = new Set<string>()
  // 当前主题。加高亮时要按它取配色,所以不能只交给 rendition.themes 自己记。
  let theme: ThemeName = 'light'
  let locationsReady = false
  // 每次 open()/destroy() 自增一次,给这次调用发出的所有异步延续盖一个“批次号”。
  // 延续恢复执行时先比对批次号,号不一样说明这次 open 已经被下一次 open 或 destroy 取代,
  // 直接放弃、不再碰任何闭包变量——用来防止过期的 open() 续写覆盖新书的状态。
  let generation = 0

  /**
   * navDocPath 是导航文档自己相对 OPF 目录的路径(book.packaging.navPath,没有
   * EPUB 3 导航文档时是 book.packaging.ncxPath——epub.js 自己解析导航时就是这么
   * 退回的,见 open() 里取值处的注释),用来把目录项里原始的 href 解析成和 spine
   * 同一基准的路径,见 href.ts 的 resolveNavigationHref() 注释。
   */
  function flatToc(items: NavItem[], depth: number, navDocPath: string, out: TocItem[]): void {
    for (const item of items) {
      const href = resolveNavigationHref(String(item.href ?? ''), navDocPath)
      out.push({ label: String(item.label ?? '').trim(), href, depth })
      if (Array.isArray(item.subitems) && item.subitems.length > 0) {
        flatToc(item.subitems, depth + 1, navDocPath, out)
      }
    }
  }

  /**
   * 把 display() 收到的目标 href 归一化匹配回 spine 实际使用的路径。
   *
   * epub.js 的 Spine.get()(node_modules/epubjs/src/spine.js)找章节靠的是一个用
   * 原始字符串(只去掉了 #锚点)当 key 的字典,并不会处理 "../"、"./" 这类相对路径
   * 写法——字典的 key 是相对 OPF 目录解析出来的路径,比如 "Text/ch1.xhtml"。
   * 但目录(TOC)里的链接是照抄导航文档自己写的原始 href,可能是
   * "../Text/ch1.xhtml" 这种从导航文档自己所在目录出发、写法不同但指向同一个
   * 文件的相对路径(见 href.ts 的注释)。直接把这种 href 传给 rendition.display()
   * 会导致 Spine.get() 查不到对应章节、_display() 用 "No Section Found" 拒绝那个
   * promise——界面上什么反应都没有,点目录跳章节悄无声息地失效。
   * 这里在真正调用 rendition.display() 之前,把目标路径归一化后到 spineHrefs
   * 里找一个归一化后相同的真实路径替换掉,找不到就原样传下去(比如本来就合法的
   * CFI、或者 undefined 表示"回到上次位置")。
   */
  function resolveDisplayTarget(target: string | undefined): string | undefined {
    if (!target || target.startsWith('epubcfi(')) return target
    const fragment = target.includes('#') ? target.slice(target.indexOf('#')) : ''
    const normalized = normalizeChapterHref(target)
    const matched = spineHrefs.find((href) => normalizeChapterHref(href) === normalized)
    return matched !== undefined ? `${matched}${fragment}` : target
  }

  /**
   * 现在有没有已经渲染出来的章节视图。所有对 epub.js 标注表的改动都先问这一句。
   *
   * epub.js 的 Annotations.remove()(node_modules/epubjs/src/annotations.js)把两件
   * 事写在"遍历当前渲染出来的视图"这个循环**里面**:从按章节分组的索引里摘掉这条
   * 记录、把画在页面上的那层 SVG 从视图上摘下来;而"从总表里删掉这条记录"那一行
   * 写在循环**外面**,无条件执行。于是一个视图都没渲染的时候调它,总表里的记录没
   * 了、分组索引里那条却留着——等这一章再渲染出来,epub.js 自己的 inject() 钩子会
   * 照着分组索引去总表里取,取到 undefined 再对它调 attach(),当场抛 TypeError,
   * 这一章直接渲染不出来。就算侥幸没抛,那块矩形也再没人摸得到了:引擎这边的账已经
   * 删掉,epub.js 那边也查不到,它既取消不了、点了也没有任何意义。
   *
   * 所以规矩是:一个视图都没渲染出来的时候,一律不碰 epub.js 的标注表,只改引擎
   * 自己这份账,等 syncHighlights() 在下一次渲染时把两边对齐。
   */
  function hasRenderedViews(): boolean {
    return (rendition?.views().length ?? 0) > 0
  }

  /** 把一段范围按当前主题画上去。现在画不了就只留在账上,等下一次渲染时补画。 */
  function attachHighlight(cfiRange: string, onClick: () => void): void {
    if (!rendition || !hasRenderedViews()) return
    // 先删一次再加:epub.js 的 Annotations 用「范围+类型」当 key 存(annotations.js
    // 的 add()),同一段重复加会把记录覆盖掉,但页面上先画的那层 SVG 矩形还挂在
    // marks-pane 上没人再摸得到,颜色越叠越深且永远删不掉。
    rendition.annotations.remove(cfiRange, 'highlight')
    pendingRemovals.delete(cfiRange)
    // 第二个参数是挂在这条标注上的自定义数据,epub.js 会往里写 epubcfi 字段
    // (iframe.js 的 highlight()),所以每次都给一个新的空对象,不要共用。
    // 第四个参数是 CSS 类名,给 undefined 就用库自己的默认值 epubjs-hl。
    rendition.annotations.highlight(cfiRange, {}, onClick, undefined, HIGHLIGHT_STYLES[theme])
  }

  /** 把一段范围从页面上摘掉。现在摘不安全就欠着,见 hasRenderedViews()。 */
  function detachHighlight(cfiRange: string): void {
    if (!rendition) return
    if (!hasRenderedViews()) {
      pendingRemovals.add(cfiRange)
      return
    }
    pendingRemovals.delete(cfiRange)
    // 第二个参数不能省:Annotations.remove() 拿「范围+类型」拼出 key 去查,
    // 少了类型就查不到任何东西,这一行会变成静默的空操作。
    rendition.annotations.remove(cfiRange, 'highlight')
  }

  /**
   * 让页面上画着的高亮和引擎这份账对齐:先把欠着的摘除补掉,再把账上的每一段按
   * 当前主题重画一遍。
   *
   * 两处会走到这里:
   *
   * - 换主题。高亮的配色是创建那一刻写死在 SVG 矩形属性上的,换主题不会自己跟着
   *   变:浅色主题那块正片叠底的黄色落到夜间的深色背景上会被压得几乎看不见,用户
   *   选了几句话顺手点了「夜间」,选中标记就没了,但引用其实还在列表里。重画要带上
   *   原来的点击回调,否则新画出来的高亮点了不取消。
   * - 章节渲染出来的时候。这一条把"加高亮的时候还没渲染"和"摘高亮的时候没有视图"
   *   两种欠账都在同一个时刻结清:欠着的摘除在这里真的摘掉,账上还没画过的在这里
   *   画上。也就是说,一段在渲染之前就记下的高亮,是在书渲染出来的那一刻出现的,
   *   而不是拖到用户下一次换主题才莫名其妙冒出来。
   */
  function syncHighlights(): void {
    if (!rendition || !hasRenderedViews()) return
    for (const cfiRange of pendingRemovals) {
      rendition.annotations.remove(cfiRange, 'highlight')
    }
    pendingRemovals.clear()
    for (const [cfiRange, onClick] of highlights) {
      attachHighlight(cfiRange, onClick)
    }
  }

  /**
   * 先把这一轮要通知的人定下来,再逐个确认他还在不在最新的名单里。
   *
   * 退订(onRelocated/onKey/onSelected 返回的那个函数)是用 filter 生成一个新数组
   * 再重新赋值的:直接遍历 listeners 这个变量,for...of 拿住的还是赋值前的旧数组,
   * 谁在别人的回调里退订都照样会收到这一轮——对一个正因为要卸载才退订的订阅者来说
   * 太晚了。反过来,在回调里新订上来的人不该被这一轮带上,快照也一并挡住了。
   * 三处分发(relocated、按键、划选)都照这个来:留着两处一样一处不一样,比三处
   * 都有同一个毛病更难查。
   */
  function notify(): void {
    const round = [...listeners]
    for (const cb of round) {
      if (listeners.includes(cb)) cb()
    }
  }

  /** 见 notify() 的注释。 */
  function notifyKey(key: string): void {
    const round = [...keyListeners]
    for (const cb of round) {
      if (keyListeners.includes(cb)) cb(key)
    }
  }

  /** 这一次按下/松开是手指还是鼠标。两者补发兼容事件的方式不同,见 swallowNextClick()。 */
  type PressKind = 'mouse' | 'touch'

  function pressKindOf(e: Event): PressKind {
    return e.type.startsWith('touch') ? 'touch' : 'mouse'
  }

  /**
   * 这一次松开算不算一次拖选的结束。鼠标只认左键。
   *
   * 不看是哪个键的话:用户用键盘或者双击选中了一段话,想右键复制,右键按下弹出
   * 菜单、松开这一下就被当成了一次划选的结束——菜单还没点,这段话已经变成引用、
   * 选区也被收走了,复制彻底做不成。中键、侧键同理,它们谁也不是用来拖选的。
   * 手指和触控笔那一路没有"哪个键"这回事,touchend 本身就是一次划选的最后一步。
   */
  function isSelectionRelease(e: Event): boolean {
    if (pressKindOf(e) === 'touch') return true
    return (e as MouseEvent).button === 0
  }

  /**
   * 每份章节文档上当前挂着的那份"吞掉下一下 click",按文档记。见 swallowNextClick()。
   * 同一份文档上同一时刻只能挂一份:两份都挂在捕获阶段,先跑到的那份一
   * stopImmediatePropagation,后一份就再也没机会解除自己,会一直留着把用户之后
   * 真想点的那一下也吞掉。
   */
  const clickSwallows = new Map<Document, () => void>()

  /**
   * 吞掉紧跟在一次"松手并消费了选区"之后补发的那一下 click。
   *
   * 为什么必须吞:真人拖完一段文字松开鼠标,浏览器紧接着会在松手那个点上再补一次
   * click(真机上量到的序列就是 mousedown → mouseup → click,三者同一个位置)。
   * 松手那一下已经把这段文字交了出去,上层随即在同一片文字上画好了高亮,于是补发
   * 的这一下正落在这块**刚画出来的**高亮里面。marks-pane 在章节文档上挂着
   * mouseup/mousedown/click/touchstart 的转发(node_modules/marks-pane/src/events.js
   * 的 proxyMouse),按坐标把它转给对应的 SVG 矩形,而矩形上挂着的正是"点它就取消"
   * 的回调(node_modules/epubjs/src/managers/views/iframe.js 的 highlight() 给
   * h.element 挂的 click/touchstart)。结果是每一次普通的拖选都画出来又立刻被自己
   * 抹掉:引用没了、高亮没了、选区也收走了,屏幕上什么都不剩。双击选词、三击选段
   * 同理,它们的最后一步也是 mouseup + click。
   *
   * 为什么挂在章节文档的**捕获阶段**就够:marks-pane 那几个转发是
   * `addEventListener(ev, ..., false)`,即挂在同一份章节文档的冒泡阶段。一个落在
   * 正文元素上的 click,传播路径是 document 捕获 → 目标元素 → 冒泡回 document,
   * 捕获阶段的 document 排在最前面,所以这里先跑到,stopImmediatePropagation()
   * 之后整条路径都走不下去,marks-pane 的转发拿不到这一下,矩形上的回调也就不会
   * 被调用。用 stopImmediatePropagation 而不是 stopPropagation,是为了连"万一某个
   * 监听器和我们挂在同一个节点同一个阶段"的情况也一并挡掉,不去赌注册顺序。
   *
   * 为什么解除时机不用定时器:定时器上的毫秒数只是在赌浏览器多快补发这一下,机器
   * 一卡就赌输,而赌输的后果是把用户真正想点的那一下吞掉。这里用事件本身定边界——
   * 要么补发的这一下 click 真的来了(吞掉它,当场解除),要么用户已经开始下一次
   * 交互(下一次按下一定排在下一次 click 前面,按下即解除)。两者谁先到都算数,
   * 所以一次只会吞掉紧挨着的那一下,过一会儿真去点高亮照样点得掉。
   */
  function swallowNextClick(doc: Document, press: PressKind): void {
    clickSwallows.get(doc)?.()
    // 解除的时机分手指和鼠标:触摸松开之后浏览器会补一整套兼容事件
    // (mousedown → mouseup → click),要吞的正是最后那一下 click,所以中间这个
    // mousedown 不能算"用户开始了下一次交互"。手指那一路只认下一次 touchstart。
    const pressEvent = press === 'touch' ? 'touchstart' : 'mousedown'
    // 捕获阶段写成 { capture: true } 而不是第三个参数给 true:两种写法在浏览器里
    // 等价,但 node 那套 EventTarget 只认对象形式,布尔形式下 removeEventListener
    // 配不上 addEventListener、退订不掉。单元测试跑在 node 上,不统一写法的话,
    // 这里的退订在测试里永远不生效,测出来的是运行环境的差异而不是这段逻辑。
    const capture = { capture: true } as const
    const disarm = (): void => {
      doc.removeEventListener('click', onClick, capture)
      doc.removeEventListener(pressEvent, disarm, capture)
      if (clickSwallows.get(doc) === disarm) clickSwallows.delete(doc)
    }
    const onClick = (e: Event): void => {
      disarm()
      e.stopImmediatePropagation()
    }
    doc.addEventListener('click', onClick, capture)
    doc.addEventListener(pressEvent, disarm, capture)
    clickSwallows.set(doc, disarm)
  }

  /** 解除所有还挂着的 click 吞噬。 */
  function disarmAllClickSwallows(): void {
    for (const disarm of [...clickSwallows.values()]) disarm()
    clickSwallows.clear()
  }

  /**
   * 把书内容里当前选中的那段文字交给订阅者,并把选区收走。
   *
   * 为什么不直接用 epub.js 的 selected 事件:那个事件是从**最后一次选区变化**起算
   * 250 毫秒的防抖(node_modules/epubjs/src/contents.js 的 onSelectionChange),不是
   * 从松开鼠标起算。用户拖慢一点、中途停一下想想,防抖就会在鼠标还按着的时候先发
   * 一次,发出去的是拖到一半的那个短范围;继续拖到底松手,又发一次完整范围。两次
   * 范围字符串不同,上层按范围去重也拦不住,结果是一次拖选变成两段一长一短、互相
   * 重叠的引用,点一下只取消得掉其中一块,取消掉哪一块还取决于两层矩形谁后画。
   *
   * 设计要求是"拖选松开即高亮",所以这里改成由 mouseup 驱动:松手那一刻自己读一次
   * 选区,算出范围再发出去。范围用 contents.cfiFromRange() 算——它和 epub.js 在
   * selected 事件里用的是同一行代码(两边都是 new EpubCFI(range, cfiBase).toString(),
   * 见 contents.js 的 cfiFromRange 与 triggerSelectedEvent),所以算出来的字符串跟
   * 事件给的完全一致,换驱动方式不会换掉范围的写法。
   *
   * 收走选区还顺带把 epub.js 那边还挂着的防抖掐掉:定时器到点时读到的是空选区,
   * 而它只在选区非折叠时才往外发事件,所以松手之后不会再补一次。
   *
   * 选区只在真的被人用掉的时候才清:原生的蓝色选中块会盖在随后加上的自定义高亮
   * 上面,两层颜色叠在一起看不出哪句已经选进引用了。反过来,没人订阅、或者这次
   * 什么文字都没选中(比如拖过了段落之间的空隙、或者只是点了一下),一定不能动
   * 选区——清掉它换不来任何东西,用户看到的只是自己刚拖出来的一段话无声无息地
   * 消失,连复制都做不到。
   *
   * 每份渲染出来的章节文档都要走一遍,不能碰到第一份有选区的就收工。双页排版下
   * 同时渲染着两份文档,它们各有各的选区,互不影响:只处理第一份的话,另一份里
   * 那段选区会一直留在那儿,等用户下一次在别处松手才被翻出来,变成一段莫名其妙
   * 冒出来的引用。
   */
  function consumeSelection(press: PressKind): void {
    if (selectionListeners.length === 0) return
    if (!rendition) return
    // getContents() 在这版 epub.js 的类型声明里被错标成单个 Contents,运行时实际
    // 返回数组(和 getVisible() 里那处断言同因),这里只在本文件内断言。
    const all = rendition.getContents() as unknown as Contents[]
    for (const contents of all) {
      const selection = contents.window?.getSelection()
      if (!selection || selection.rangeCount === 0) continue
      const range = selection.getRangeAt(0)
      if (range.collapsed) continue
      const text = selection.toString()
      if (text.trim().length === 0) continue

      let cfiRange: string
      try {
        cfiRange = contents.cfiFromRange(range)
      } catch {
        // 选区落在 epub.js 算不出 CFI 的地方。这里是鼠标事件的回调,抛出去没有任何
        // 调用栈接得住,会变成未捕获的全局异常,只能放弃这一次划选。
        continue
      }

      // 这段选区马上就会变成一块盖在同一片文字上的高亮,而松手之后浏览器还会在
      // 松手那个点上补一次 click——正落在这块新高亮里。先把那一下挡下来,
      // 否则这次划选画出来就被自己抹掉,见 swallowNextClick() 的注释。
      swallowNextClick(contents.document, press)
      // 快照一份再逐个确认还在不在名单里,理由见 notify() 的注释。
      const round = [...selectionListeners]
      for (const cb of round) {
        if (selectionListeners.includes(cb)) cb(cfiRange, text)
      }
      // 通知完了才收选区,顺序不能倒过来。这是鼠标事件的回调,没有任何调用栈接得住
      // 订阅者抛出来的异常:先收选区的话,一个订阅者炸了,后面的订阅者收不到通知,
      // 而选区已经没了——引用没加上,用户手里连可复制的文字都不剩。留着选区,至少
      // 他刚拖出来的那段话还在。
      selection.removeAllRanges()
    }
  }

  /**
   * 这一次按下是不是落在书内容里。见 handleOuterRelease() 的注释。
   * 书内容是一份独立的文档,它里面的事件不会冒到外层,所以两边各自看到的按下
   * 天然是互斥的:里面按下就只有 rendition 收得到,外面按下就只有外层窗口收得到。
   */
  let pressedInContent = false

  function handleContentPress(): void {
    pressedInContent = true
  }

  function handleOuterPress(): void {
    pressedInContent = false
  }

  /**
   * 在书内容里松手。走 epub.js 转发的 mouseup/touchend——它把每份章节文档上的
   * DOM_EVENTS 都转发到 rendition 上(见 utils/constants.js 的 DOM_EVENTS 和
   * rendition.js 的 passEvents,mouseup 和 touchend 都在那个列表里),和 keydown
   * 走同一条路,不需要我们自己往每份文档上挂监听。
   *
   * 手指和触控笔也要接:它们划完一段文字的最后一步是 touchend,不是 mouseup。
   * 只听 mouseup 的话,在触摸屏上划选完全没有任何反应。
   */
  function handleContentRelease(e: Event): void {
    pressedInContent = false
    if (!isSelectionRelease(e)) return
    consumeSelection(pressKindOf(e))
  }

  /**
   * 在书内容外面松手。只有当这一次按下本来就落在书内容里(也就是真的是一次从书里
   * 开始、拖出了 iframe 才松开的拖选)才算数。
   *
   * 不看这个的话,外层界面上任何一次松开都会被当成一次拖选的结束:用户用键盘选中
   * 了一段话,随手去点工具栏上的一个按钮,那一下松开落在外层窗口上,就会把这段话
   * 悄悄变成一条引用——他既没打算引用它,也不知道自己刚引用了什么。
   */
  function handleOuterRelease(e: Event): void {
    const startedInContent = pressedInContent
    // 不管这一下算不算划选的结束,按下-松开这一轮都结束了:标记要复位,否则一次
    // 右键松开会把"这次按下落在书内容里"这个状态留给下一次左键松开。
    pressedInContent = false
    if (!startedInContent || !isSelectionRelease(e)) return
    consumeSelection(pressKindOf(e))
  }

  /**
   * 处理外层窗口(阅读界面的按钮、工具栏等,不在 epub.js 的 iframe 里)上的 keydown。
   * 从 createEngine() 调用起就订阅,直到 destroy() 才取消——与某一次 open() 的
   * book/rendition 无关,所以不放在 open() 里注册。
   */
  function handleWindowKeydown(e: KeyboardEvent): void {
    notifyKey(e.key)
  }

  /**
   * 处理书本内容(epub.js 渲染进 iframe 里的文档)上的 keydown。
   *
   * epub.js 的 Rendition 构造函数里默认把 passEvents 注册到 hooks.content(见
   * node_modules/epubjs/src/rendition.js 的 constructor 和 passEvents 方法):每次一个
   * 章节的 iframe 文档渲染完成,Contents 实例会在自己的 document 上挂 DOM_EVENTS 列表
   * (包含 keydown,见 utils/constants.js 和 contents.js 的 addEventListeners),再把
   * 收到的原生事件通过 rendition.emit(e.type, e, contents) 转发到 rendition 自己身上。
   * 也就是说 rendition.on('keydown', cb) 不需要我们自己再往每个渲染文档上挂监听器——
   * 库本身已经把书内容 iframe 里的按键转发出来了,cb 收到的就是原生 KeyboardEvent。
   * Contents.addEventListeners()/removeEventListeners() 由 epub.js 在每次渲染/卸载
   * 文档时自动管理,所以翻页、换章节都不会导致这里的监听重复挂载。
   */
  function handleContentKeydown(e: KeyboardEvent): void {
    notifyKey(e.key)
  }

  window.addEventListener('keydown', handleWindowKeydown)
  // 拖选拖出了书内容 iframe、在外面松手时,那一下只有外层窗口收得到(iframe 里的
  // 文档和外层是两份文档,事件不会从里面冒到外面)。和上面的 keydown 一样,
  // 从 createEngine() 起订到 destroy(),跟某一次 open() 的 rendition 无关。
  // 按下也要接:外层界面上的按下说明这一次不是从书里开始的拖选,见 handleOuterRelease()。
  window.addEventListener('mousedown', handleOuterPress)
  window.addEventListener('touchstart', handleOuterPress)
  window.addEventListener('mouseup', handleOuterRelease)
  window.addEventListener('touchend', handleOuterRelease)

  /**
   * 释放某次 open() 调用在本地创建、但还没发布到闭包变量就被取代的 book/rendition。
   * 用在 open() 里每一处 `epoch !== generation` 判断为真之后、return 之前。
   *
   * 光调用 rendition.destroy() 并不够:epub.js 的 Rendition.destroy()(见
   * node_modules/epubjs/src/rendition.js)里清空自身任务队列的那行 `this.q.clear()`
   * 是注释掉的——它自己排队等 book.opened 之后要跑的 start()/attachTo() 渲染步骤
   * 不会被这次 destroy() 打断。也就是说,如果这次 open() 在 manager.render() 真正
   * 执行之前就已经过期,那个 render() 调用仍会按原计划在之后的某一帧触发,往容器里
   * 插入一个没人认领的 stage 元素(iframe 的父容器)、注册永久性的 window
   * resize/orientationchange 监听(见 managers/helpers/stage.js 的 onResize /
   * onOrientationChange)。所以这里先调用 q.stop() 清空并冻结这个内部队列,不让它
   * 继续往下跑;render() 如果已经先一步执行完,再靠 destroy() 去清已经建出来的
   * manager/stage。
   *
   * 如果 render() 还没执行到,manager 可能已经被 start() 建出来但
   * manager.container/manager.stage 还没有——这种半成品状态下 epub.js 自带的
   * DefaultViewManager.destroy() 会直接访问 this.container(在
   * removeEventListeners() 里)和 this.stage(destroy() 最后一行),两者都还是
   * undefined,会抛 TypeError。这里用 try/catch 兜底,不能让清理旧对象的动作把
   * open() 的调用方炸掉。
   */
  function destroyStale(staleBook: Book, staleRendition: Rendition): void {
    staleRendition.q.stop()
    staleRendition.off('relocated', notify)
    staleRendition.off('keydown', handleContentKeydown)
    staleRendition.off('mousedown', handleContentPress)
    staleRendition.off('touchstart', handleContentPress)
    staleRendition.off('mouseup', handleContentRelease)
    staleRendition.off('touchend', handleContentRelease)
    staleRendition.off('rendered', syncHighlights)
    try {
      staleRendition.destroy()
    } catch {
      // 忽略:render() 还没跑到,没有 manager/stage 可清
    }
    try {
      staleBook.destroy()
    } catch {
      // 忽略:与上面同理
    }
  }

  /**
   * 销毁当前的 rendition/book,清空容器,把状态复位到初始值。
   * 供 open()(重新打开前先清场)和 destroy()(退出阅读界面)共用。
   * 注意:这不是对外的 destroy() ——它不清空 listeners,重新 open 之后旧的
   * onRelocated 订阅者应当继续收到新书的通知。
   */
  function teardown(): void {
    // 挂在旧章节文档上的那个"吞掉下一下 click"要先摘掉:文档马上就跟着 rendition
    // 一起没了,监听器本身会跟着消失,但 disarmClickSwallow 这个引用留在这里,
    // 下一次划选时 swallowNextClick() 会先调它一次,对着一份已经销毁的文档做事。
    disarmAllClickSwallows()
    pressedInContent = false
    // 位置变化的订阅和下面几个一样要还回去:这是本文件自己立的规矩——订上去的
    // 每一个都在 teardown() 里退掉。这一条以前漏了,只是因为紧接着 rendition
    // 就被销毁、引用也被置空才没出事,那是碰巧,不是规矩。
    rendition?.off('relocated', notify)
    rendition?.off('keydown', handleContentKeydown)
    rendition?.off('mousedown', handleContentPress)
    rendition?.off('touchstart', handleContentPress)
    rendition?.off('mouseup', handleContentRelease)
    rendition?.off('touchend', handleContentRelease)
    rendition?.off('rendered', syncHighlights)
    // rendition.q 里可能还排着一个我们自己调用过、还没跑到的 display() 任务(见
    // ReaderView.boot() 里 `await engine.display(...)`):它是 epub.js 内部靠
    // requestAnimationFrame 驱动的队列,当前这一帧不一定跑得到它。如果不在这里
    // 先 q.stop() 清空排队项,这个任务会在之后某一帧才真正执行到
    // Rendition._display(),届时下面 book.destroy() 已经把 book.locations 内部
    // 状态清掉了,但 rendition.book 这个引用本身没变,_display() 一开始就会摸
    // `this.book.locations.length()`,对着已销毁的 Locations 抛 TypeError——这是
    // 一次脱离了当前调用栈的异步执行,没有任何 try/catch 接得住,会变成未捕获的
    // 全局异常,把整个 React 渲染树崩掉。跟 destroyStale() 里对新书 stale
    // rendition 做的处理一样,先停队列,把还没跑的任务直接扔掉。
    rendition?.q.stop()
    // rendition/book 在这里可能和 destroyStale() 里一样是"半成品"状态:open() 已经
    // 把它们发布到闭包变量(book = nextBook; rendition = nextRendition 那一步已经跑
    // 过),但 epub.js 内部 manager.render() 还没真正跑完——render() 之前
    // DefaultViewManager 的 this.container 还是 undefined,它自己的
    // removeEventListeners() 会直接对 undefined 调用 removeEventListener 抛
    // TypeError(见上面 destroyStale() 的注释)。这条路径此前没有 try/catch,
    // 用户在 boot() 还没跑完时就点击返回书架,会让这个 TypeError 从 React 的
    // effect 清理函数里原样抛出去、没有任何错误边界接住,把整个渲染树崩掉、
    // 界面变成一片空白且再也回不去书架。跟 destroyStale() 一样兜底,不能让
    // 清理旧对象的动作把调用方炸掉。
    try {
      rendition?.destroy()
    } catch {
      // 忽略:render() 还没跑到,没有 manager/stage 可清
    }
    try {
      book?.destroy()
    } catch {
      // 忽略:与上面同理
    }
    // epub.js 的 Stage.attachTo 只会往容器里追加自己的 stage 元素,不会清理旧的,
    // 所以这里手动清空容器,否则连续 open() 会在 DOM 里叠出多个 iframe。
    container.replaceChildren()
    rendition = null
    book = null
    toc = []
    spineHrefs = []
    // 高亮跟着 rendition 一起没了,这里只需要把自己记的那份账清掉。留着的话,
    // 下一本书刚打开就会以为页面上已经有高亮,clearHighlights() 会对着新书里
    // 根本不存在的范围做删除。
    highlights.clear()
    // 欠着的摘除也跟着这本书一起作废:范围字符串是这本书的,留到下一本书上
    // 只会对着不存在的范围做删除。
    pendingRemovals.clear()
    locationsReady = false
  }

  return {
    async open(data: ArrayBuffer, opts: OpenOptions): Promise<void> {
      teardown()
      const epoch = ++generation

      const nextBook = ePub(data)
      const nextRendition = nextBook.renderTo(container, {
        width: '100%',
        height: '100%',
        flow: 'paginated',
        spread: 'none',
        allowScriptedContent: false
      })
      nextRendition.themes.register('light', THEMES.light)
      nextRendition.themes.register('dark', THEMES.dark)
      nextRendition.themes.select(opts.theme)
      theme = opts.theme
      nextRendition.themes.fontSize(`${opts.fontSize}px`)

      await nextBook.ready
      // destroy() 或另一次 open() 可能在 await 期间抢先执行,批次号已经变了就不再往下走,
      // 避免对已经被 teardown 过的 book/rendition 继续操作。
      // 这次 open() 已经被取代,但 nextBook/nextRendition 是它自己 new 出来的本地对象,
      // 从没发布到闭包变量,teardown() 根本碰不到它们——必须在这里主动释放,否则
      // epub.js 内部队列会在 book.opened resolve 之后继续插入 iframe、注册永久监听。
      if (epoch !== generation) {
        destroyStale(nextBook, nextRendition)
        return
      }

      const nav = await nextBook.loaded.navigation
      if (epoch !== generation) {
        destroyStale(nextBook, nextRendition)
        return
      }

      // book.packaging.navPath 是 EPUB 3 导航文档相对 OPF 目录的路径,没有导航文档、
      // 只用 EPUB 2 toc.ncx 时是空字符串——这时退回 ncxPath,和 epub.js 自己
      // loadNavigation() 里 `packaging.navPath || packaging.ncxPath` 的退回逻辑保持
      // 一致,因为 nav.toc 本来就是从这两者之一解析出来的。
      const navDocPath = nextBook.packaging.navPath || nextBook.packaging.ncxPath || ''
      const items: TocItem[] = []
      flatToc(nav.toc, 0, navDocPath, items)

      // epub.js 的类型声明里 Spine.each() 只标成 (...args: any[]) => any,没有把
      // 回调参数标成 Section——这里只声明用得到的 href 字段,断言过去。
      const hrefs: string[] = []
      nextBook.spine.each((section: { href: string }) => {
        hrefs.push(section.href)
      })

      // 到这里两次 epoch 检查都通过,这次 open() 没有被取代,才正式发布到闭包变量。
      book = nextBook
      rendition = nextRendition
      toc = items
      spineHrefs = hrefs

      if (opts.savedLocations) {
        nextBook.locations.load(opts.savedLocations)
        locationsReady = true
      } else {
        void nextBook.locations.generate(LOCATION_CHUNK).then(() => {
          // 同一本书可能因为 open() 被再次调用而在 generate() 完成前就已经过期,
          // 这里必须再查一次批次号,否则旧书生成完成的那一刻会把 locationsReady
          // 错误地置为 true,污染的是新书(或已销毁状态)的读数。
          // 此时 nextBook/nextRendition 通常已经被后来的 teardown() 当作
          // book/rendition 销毁过一次,但那两个闭包变量已经指向别的对象或 null,
          // 这里手上的本地引用还在——统一走 destroyStale() 再销毁一次,
          // epub.js 内部对重复 destroy() 有 `this.xxx &&` 式的判空保护,不会出错。
          if (epoch !== generation) {
            destroyStale(nextBook, nextRendition)
            return
          }
          locationsReady = true
          notify()
        })
      }

      nextRendition.on('relocated', notify)
      // 见上面 handleContentKeydown 的注释:这一行订阅之后,书内容 iframe 里发生的
      // keydown 会被 epub.js 自己转发到这里,不需要我们逐个文档去挂监听器。
      nextRendition.on('keydown', handleContentKeydown)
      // 松手即高亮:mouseup / touchend 同样是 epub.js 自己从每份章节文档上收上来再
      // 转发的(见 handleContentRelease 的注释),和 keydown 一样只在这里订阅一次。
      // 注意这几行在两次批次号检查之后,被取代的那次 open() 走不到这里,不会给一个
      // 马上要销毁的 rendition 挂监听。
      nextRendition.on('mousedown', handleContentPress)
      nextRendition.on('touchstart', handleContentPress)
      nextRendition.on('mouseup', handleContentRelease)
      nextRendition.on('touchend', handleContentRelease)
      // 章节渲染出来的那一刻把高亮和引擎这份账对齐一次,见 syncHighlights() 的注释。
      // 和上面两行一样在两次批次号检查之后,被取代的那次 open() 走不到这里。
      nextRendition.on('rendered', syncHighlights)
    },

    async display(target?: string): Promise<void> {
      if (!rendition) throw new Error('书还没打开')
      await rendition.display(resolveDisplayTarget(target))
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
      theme = name
      rendition?.themes.select(name)
      // 配色跟着主题走,见 syncHighlights() 的注释。
      syncHighlights()
    },

    async getVisible(): Promise<VisibleRange> {
      if (!book || !rendition?.location) throw new Error('书还没打开')
      const { start, end } = rendition.location

      let text = ''
      let rangeCfi = ''
      // 只有下面的 try 正常走完才是"屏幕上精确可见的那一小段";一旦落进 catch,
      // text 就是整份章节文档的全文这种近似值,调用方必须能分辨这两种情况
      // (见 types.ts 里 VisibleRange.approximate 的注释)。
      let approximate = false
      try {
        // makeRangeCfi 在 CFI 不合法、缺少章节分隔符、或起止跨越两个章节时会抛错
        rangeCfi = makeRangeCfi(start.cfi, end.cfi)
        const range = await book.getRange(rangeCfi)
        text = range.toString().replace(/\s+/g, ' ').trim()
      } catch {
        // 退化方案:范围合成或取值失败(常见于可见区域跨越两个章节文档)时,
        // 直接读取当前渲染的第一个文档的全文作为近似正文——注意这通常会超过一屏的内容,
        // 只是为了不让上层拿到完全空白的正文。
        rangeCfi = ''
        approximate = true
        // rendition.getContents() 在这版 epub.js 的类型声明里被错标成单个 Contents,
        // 运行时实际返回数组,这里只在本文件内断言,不改动对外类型。
        const contents = rendition.getContents() as unknown as Contents[]
        // 注:翻页动画进行中 getContents() 可能瞬时返回空数组,此时 body 取不到,text 会退化成空字符串。
        const body = contents[0]?.document?.body
        text = (body?.textContent ?? '').replace(/\s+/g, ' ').trim()
      }

      const href = String(start.href ?? '')
      // 不能直接比较原始字符串:目录里的链接和 spine 报告的路径即使指向同一份文档,
      // 写法也可能不同(比如目录带 ../ 前缀、或者带 #锚点),按归一化后的路径比较。
      const entry = toc.find((t) => normalizeChapterHref(t.href) === normalizeChapterHref(href))
      const locations = book.locations as unknown as LocationsWithTotal
      const page = locationsReady ? locations.locationFromCfi(start.cfi) + 1 : 0
      const totalPages = locationsReady ? locations.total : 0

      return {
        text,
        approximate,
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

    onKey(cb: (key: string) => void): () => void {
      keyListeners.push(cb)
      return () => {
        keyListeners = keyListeners.filter((x) => x !== cb)
      }
    },

    onSelected(cb: (cfiRange: string, text: string) => void): () => void {
      selectionListeners.push(cb)
      return () => {
        selectionListeners = selectionListeners.filter((x) => x !== cb)
      }
    },

    addHighlight(cfiRange: string, onClick: () => void): void {
      // 先记账,再看画不画得出来。书还没渲染出来时(引擎刚建好、open() 还没跑完)
      // 直接返回、连账都不记的话,上层的引用列表里已经躺着这一段,引擎这边却当它
      // 从来没存在过:这条引用永远不会有对应的高亮,clearHighlights() 也数不到它。
      // 记下来两边对同一段范围的认知才是一致的,而且章节一渲染出来 syncHighlights()
      // 就会把它画上(见那个函数的注释)。这份账跟着当前这本书走,teardown() 会连它
      // 一起清掉,不会带到下一本书。
      highlights.set(cfiRange, onClick)
      attachHighlight(cfiRange, onClick)
    },

    removeHighlight(cfiRange: string): void {
      highlights.delete(cfiRange)
      detachHighlight(cfiRange)
    },

    clearHighlights(): void {
      for (const cfiRange of highlights.keys()) {
        detachHighlight(cfiRange)
      }
      highlights.clear()
    },

    destroy(): void {
      // 先递增批次号,让任何还没跑完的 open() 延续(book.ready / navigation /
      // locations.generate 的 then)在恢复执行时立刻发现自己已经过期并退出,
      // 不再触碰马上要被 teardown 的 book/rendition。
      generation++
      teardown()
      listeners = []
      keyListeners = []
      selectionListeners = []
      window.removeEventListener('keydown', handleWindowKeydown)
      window.removeEventListener('mousedown', handleOuterPress)
      window.removeEventListener('touchstart', handleOuterPress)
      window.removeEventListener('mouseup', handleOuterRelease)
      window.removeEventListener('touchend', handleOuterRelease)
    }
  }
}

export type { ReaderEngine } from './types'
