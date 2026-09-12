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
