import { prisma } from '../../lib/prisma.js'

/**
 * 广告公开接口数据（前台各广告位只读）。
 * 广告的增删改由 Cool Admin 后台直接管理（共用 forum 库），
 * 业务侧只提供读，见 routes/advert.routes.ts。
 */
export interface AdvertPublic {
  /** 广告 ID */
  id: number
  /** 广告标题（img alt / 后台识别），可空 */
  title: string | null
  /** banner 图片 URL */
  image: string
  /** 广告位置：sidebar(侧边栏) | inline(列表内嵌) */
  position: string
  /** 跳转链接，null 表示不可点击 */
  link: string | null
  /** 排序权重，越大越靠前 */
  sortOrder: number
}

/**
 * 查询上线广告列表（前台各广告位用）。
 * 只返回 isActive=true，按 sortOrder 倒序、createdAt 倒序。
 */
export async function listActiveAdverts(): Promise<AdvertPublic[]> {
  const rows = await prisma.advert.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, title: true, image: true, position: true, link: true, sortOrder: true },
  })

  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    image: a.image,
    position: a.position,
    link: a.link,
    sortOrder: a.sortOrder,
  }))
}
