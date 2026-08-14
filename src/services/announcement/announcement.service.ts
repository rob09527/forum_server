import { prisma } from '../../lib/prisma.js'

/**
 * 公告公开接口数据（前台公告栏只读）。
 * 公告的增删改由 Cool Admin 后台直接管理（共用 forum 库），
 * 业务侧只提供读，见 routes/announcement.routes.ts。
 */
export interface AnnouncementPublic {
  /** 公告 ID */
  id: number
  /** 公告标题 */
  title: string
  /** 公告类型：normal(普通) | important(重要) | urgent(紧急) | activity(活动) */
  type: string
  /** 跳转链接，null 表示不可点击 */
  link: string | null
  /** 排序权重，越大越靠前 */
  sortOrder: number
  /** 创建时间，ISO 8601 */
  createdAt: string
}

/**
 * 查询上线公告列表（前台公告栏用）。
 * 只返回 isActive=true，按 sortOrder 倒序、createdAt 倒序。
 */
export async function listActiveAnnouncements(): Promise<AnnouncementPublic[]> {
  const rows = await prisma.announcement.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, title: true, type: true, link: true, sortOrder: true, createdAt: true },
  })

  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    type: a.type,
    link: a.link,
    sortOrder: a.sortOrder,
    createdAt: a.createdAt.toISOString(),
  }))
}
