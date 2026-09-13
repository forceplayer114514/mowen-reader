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
