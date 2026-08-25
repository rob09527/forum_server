import { effectiveAvatar } from '../../utils/avatar.js'

/**
 * 作者公开摘要 + 装饰生效槽（消费体系 1.3.7 装饰全站渲染的后端半边）。
 *
 * 装饰是横切读：帖子列表/详情、评论、搜索水合、@提及候选都要带作者装饰列，
 * 前端按「expireAt 未过期才生效」内联渲染 [1.8][1.3.7]。统一投影常量避免三处散落 select 遗漏装饰列。
 *
 * 存量 User 只存「当前生效的那一个」装饰值（单槽模型），服务端无缓存层，
 * 装饰改动零缓存失效问题 [2.2]。
 */
export interface AuthorBrief {
  /** 作者 ID */
  id: number
  /** 用户名 */
  username: string
  /** 生效头像路径（已折叠：租用头像未过期优先，否则基础头像） */
  avatar: string | null
  /** 等级 key（claw/leg/meat） */
  level: string
  /** 生效中的用户名颜色渲染值（CSS 色值/渐变）；null 或已过期则不上色 [R44] */
  decorColorValue: string | null
  /** 用户名颜色到期时间 */
  decorColorExpireAt: Date | null
  /** 生效中的称号文本；null 或已过期则无称号 */
  decorTitleValue: string | null
  /** 称号徽章配色 key（amber | violet | emerald …），与 decorTitleValue 成对存储 */
  decorTitleStyle: string | null
  /** 称号到期时间 */
  decorTitleExpireAt: Date | null
}

/** author select 常量：所有列表/评论/详情查询统一复用，避免装饰列遗漏或 N+1 */
export const AUTHOR_SELECT = {
  id: true,
  username: true,
  avatar: true,
  level: true,
  decorAvatarValue: true,
  decorAvatarExpireAt: true,
  decorColorValue: true,
  decorColorExpireAt: true,
  decorTitleValue: true,
  decorTitleStyle: true,
  decorTitleExpireAt: true,
} as const

/** AUTHOR_SELECT 的原始行（含租用头像覆盖层两列），供 toAuthorBrief 折叠 */
export type AuthorRow = AuthorBrief & {
  decorAvatarValue: string | null
  decorAvatarExpireAt: Date | null
}

/**
 * 原始 author 行 → AuthorBrief。
 * 统一在此折叠「生效头像」：租用头像（decorAvatarValue）未过期优先，否则基础头像（avatar）。
 * 所有消费 AUTHOR_SELECT 的服务在映射 DTO 时调用，保证双槽对下游透明。
 */
export function toAuthorBrief(row: AuthorRow): AuthorBrief {
  return {
    id: row.id,
    username: row.username,
    avatar: effectiveAvatar(row.avatar, row.decorAvatarValue, row.decorAvatarExpireAt),
    level: row.level,
    decorColorValue: row.decorColorValue,
    decorColorExpireAt: row.decorColorExpireAt,
    decorTitleValue: row.decorTitleValue,
    decorTitleStyle: row.decorTitleStyle,
    decorTitleExpireAt: row.decorTitleExpireAt,
  }
}
