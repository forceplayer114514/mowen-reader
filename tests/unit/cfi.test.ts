import { describe, expect, it } from 'vitest'
import { makeRangeCfi } from '../../src/renderer/reader/cfi'

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

  it('[id] 断言里转义的 ] 在往返中完整保留', () => {
    const r = makeRangeCfi('epubcfi(/6/4[cha^]p]!/4/2/2/1:0)', 'epubcfi(/6/4[cha^]p]!/4/2/8/1:12)')
    expect(r).toBe('epubcfi(/6/4[cha^]p]!/4/2,/2/1:0,/8/1:12)')
  })

  it('起点和终点落在同一文本节点,只是字符偏移不同', () => {
    const r = makeRangeCfi('epubcfi(/6/4!/4/2/2/1:3)', 'epubcfi(/6/4!/4/2/2/1:9)')
    expect(r).toBe('epubcfi(/6/4!/4/2/2,/1:3,/1:9)')
  })

  it('两侧偏移都是 0 时不会被当成缺失而丢掉', () => {
    const r = makeRangeCfi('epubcfi(/6/4!/4/2/2/1:0)', 'epubcfi(/6/4!/4/2/2/1:0)')
    expect(r).toBe('epubcfi(/6/4!/4/2/2,/1:0,/1:0)')
  })
})
