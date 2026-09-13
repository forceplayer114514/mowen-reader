import { describe, expect, it } from 'vitest'
import { compareCfiPositions, makeRangeCfi } from '../../src/renderer/reader/cfi'

describe('范围 CFI 合成', () => {
  it('同一章内的两点合成带逗号的范围', () => {
    const r = makeRangeCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/8/1:12)')
    expect(r).toBe('epubcfi(/6/4!/4/2,/2/1:0,/8/1:12)')
  })

  it('公共前缀被提取到逗号前,不在两个分支里重复', () => {
    const r = makeRangeCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/8/1:12)')
    const [common] = r.split(',')
    expect(common).toBe('epubcfi(/6/4!/4/2')
  })

  it('起点和终点完全相同时仍返回合法的 epubcfi 字符串', () => {
    const same = 'epubcfi(/6/4!/4/2/2/1:0)'
    const r = makeRangeCfi(same, same)
    expect(r).toBe('epubcfi(/6/4!/4/2/2,/1:0,/1:0)')
  })

  it('跨章节时抛出错误,不再合成畸形的双逗号标记', () => {
    expect(() => makeRangeCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/6!/4/2/2/1:5)')).toThrow(
      '起止位置不在同一章节,无法合成范围'
    )
  })

  it('传入不是 epubcfi 的字符串时抛出可读的错误', () => {
    expect(() => makeRangeCfi('随便什么', 'epubcfi(/6/4!/4/2/2/1:0)')).toThrow(/CFI/)
  })

  it('起止顺序颠倒时自动交换,结果与正序输入一致', () => {
    const reversed = makeRangeCfi('epubcfi(/6/4!/4/2/8/1:12)', 'epubcfi(/6/4!/4/2/2/1:0)')
    const forward = makeRangeCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/8/1:12)')
    expect(reversed).toBe(forward)
    expect(reversed).toBe('epubcfi(/6/4!/4/2,/2/1:0,/8/1:12)')
  })

  it('缺少章节分隔符 ! 时抛出错误', () => {
    expect(() => makeRangeCfi('epubcfi(/4/2/2/1:0)', 'epubcfi(/4/2/8/1:12)')).toThrow(
      'CFI 缺少章节分隔符:epubcfi(/4/2/2/1:0)'
    )
  })

  // 下面两个用例取代了原来那个"[id] 断言里转义的 ] 在往返中完整保留"用例——
  // 那个用例把带转义 ] 的断言放在 "!" 之前的章节前缀(base)里,而 base 是原样
  // 整段切下来直接拼回输出的字符串,根本不会走 parseSegment() 解析,断言写没写对
  // 都不影响结果,测不出转义处理的 bug。这里把转义断言挪到 "!" 之后、真正会被
  // parseSegment() 解析成 Step 的部分,才是实际会触发解析的代码路径。

  it('[id] 断言里转义的 ] 不会被提前截断——起止位置相同时的往返', () => {
    const same = 'epubcfi(/6/4!/4/2[cha^]p]/1:0)'
    const r = makeRangeCfi(same, same)
    // 如果 ] 被提前截断,断言会变成 "cha^"、丢掉后面的 "]p",输出会是
    // "epubcfi(/6/4!/4/2[cha^],/1:0,/1:0)" 这种残缺形式。
    expect(r).toBe('epubcfi(/6/4!/4/2[cha^]p],/1:0,/1:0)')
  })

  it('[id] 断言里转义的 ] 不会被提前截断——起止位置不同时的完整流程', () => {
    const r = makeRangeCfi('epubcfi(/6/4!/4/2[cha^]p]/2/1:0)', 'epubcfi(/6/4!/4/2[cha^]p]/8/1:12)')
    expect(r).toBe('epubcfi(/6/4!/4/2[cha^]p],/2/1:0,/8/1:12)')
  })

  it('起点和终点落在同一文本节点,只是字符偏移不同', () => {
    const r = makeRangeCfi('epubcfi(/6/4!/4/2/2/1:3)', 'epubcfi(/6/4!/4/2/2/1:9)')
    expect(r).toBe('epubcfi(/6/4!/4/2/2,/1:3,/1:9)')
  })

  it('两侧偏移都是 0 时不会被当成缺失而丢掉', () => {
    const r = makeRangeCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/2/1:0)')
    expect(r).toBe('epubcfi(/6/4!/4/2/2,/1:0,/1:0)')
  })

  it('完全没有偏移量的标记和显式 :0 的标记不是同一个位置,顺序颠倒时仍会被纠正', () => {
    // 两者路径完全相同(/4/2/8),一个带 :0,另一个整个终止段都没有冒号。
    // 如果把"没有偏移量"当成 0 处理,两者会被判定成相同位置、不需要交换,
    // 结果分支顺序会和这里反过来(:0 那支变成第一支)。
    const r = makeRangeCfi('epubcfi(/6/4!/4/2/8:0)', 'epubcfi(/6/4!/4/2/8)')
    expect(r).toBe('epubcfi(/6/4!/4/2,/8,/8:0)')
  })
})

describe('compareCfiPositions', () => {
  it('同一章节内,路径序号更小的排在前面', () => {
    expect(
      compareCfiPositions('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/8/1:12)')
    ).toBeLessThan(0)
    expect(
      compareCfiPositions('epubcfi(/6/4!/4/2/8/1:12)', 'epubcfi(/6/4!/4/2/2/1:0)')
    ).toBeGreaterThan(0)
  })

  it('路径相同、偏移量不同时按偏移量比较', () => {
    expect(compareCfiPositions('epubcfi(/6/4!/4/2/1:3)', 'epubcfi(/6/4!/4/2/1:9)')).toBeLessThan(0)
  })

  it('完全没有偏移量的标记视为在显式 :0 之前', () => {
    expect(compareCfiPositions('epubcfi(/6/4!/4/2/8)', 'epubcfi(/6/4!/4/2/8:0)')).toBeLessThan(0)
  })

  it('位置完全相同时返回 0', () => {
    expect(compareCfiPositions('epubcfi(/6/4!/4/2/1:3)', 'epubcfi(/6/4!/4/2/1:3)')).toBe(0)
  })
})
