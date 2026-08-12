import { prisma } from '../../lib/prisma.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { NotFoundError, ValidationError } from '../../utils/errors.js'
import { levelProgress } from '../points/points.service.js'
import type { LevelProgress } from '../points/points.service.js'
import { ALLOWED_AVATAR_STYLES } from '../../constants/business.js'
import type { UserPublic } from '../auth/auth.service.js'

/**
 * 用户公开资料 + 积分流水服务。
 * 资料公开（不返回邮箱/手机等敏感字段），积分明细同样公开，与 NodeSeek 一致。
 */

/** 公开用户资料（资料页展示用） */
export interface UserProfile {
  /** 用户 ID */
  id: number
  /** 用户名 */
  username: string
  /** 头像 URL，null 时前端用默认头像 */
  avatar: string | null
  /** 个人简介，最长 200 字符 */
  bio: string | null
  /** 用户等级（按累计鸡腿实时计算，[R21] 权威来源在 points.service） */
  level: string
  /** 鸡腿余额（可花费） */
  points: number
  /** 累计获得鸡腿，只增不减，决定等级 [R20] */
  totalPointsEarned: number
  /** 星辰（荣誉，只增不减，管理发放）[R30] */
  stars: number
  /** 发帖数（冗余字段） */
  postCount: number
  /** 评论数（冗余字段） */
  commentCount: number
  /** 注册时间，ISO 8601 */
  createdAt: string
  /** 等级进度：下一等级门槛 + 还差多少 [R21] */
  levelProgress: LevelProgress
}

/** 积分流水项 */
export interface PointLogItem {
  /** 流水 ID */
  id: number
  /** 积分来源：checkin(签到) | post(发帖) | comment(评论) | liked(被点赞) */
  type: string
  /** 变动值（正数，MVP 无扣分）[R41] */
  delta: number
  /** 变动后鸡腿余额 [R42] */
  balanceAfter: number
  /** 关联帖子/评论 ID，无关联为 null */
  refId: number | null
  /** 变动时间，ISO 8601 */
  createdAt: string
}

/** 分页结果 */
export interface Paginated<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/** 查询用户公开资料 */
export async function getUserProfile(userId: number): Promise<UserProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      avatar: true,
      bio: true,
      level: true,
      points: true,
      totalPointsEarned: true,
      stars: true,
      postCount: true,
      commentCount: true,
      createdAt: true,
    },
  })
  if (!user) {
    throw new NotFoundError('用户', ErrorCode.NOT_FOUND)
  }

  // 等级以累计鸡腿实时计算为准（[R20][R21]），不信任可能过期的 DB 冗余字段
  const progress = levelProgress(user.totalPointsEarned)

  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    bio: user.bio,
    level: progress.level,
    points: user.points,
    totalPointsEarned: user.totalPointsEarned,
    stars: user.stars,
    postCount: user.postCount,
    commentCount: user.commentCount,
    createdAt: user.createdAt.toISOString(),
    levelProgress: progress,
  }
}

/** 分页查询用户积分流水，按时间倒序 */
export async function getUserPointsLog(
  userId: number,
  page = 1,
  pageSize = 20,
): Promise<Paginated<PointLogItem>> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) {
    throw new NotFoundError('用户', ErrorCode.NOT_FOUND)
  }

  // 页码/页大小校验：非法值抛校验错误（避免 skip: NaN 导致 500）
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError('页码必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('每页条数必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  const safePageSize = Math.min(50, pageSize)

  const [total, rows] = await Promise.all([
    prisma.pointLog.count({ where: { userId } }),
    prisma.pointLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * safePageSize,
      take: safePageSize,
    }),
  ])

  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      delta: r.delta,
      balanceAfter: r.balanceAfter,
      refId: r.refId,
      createdAt: r.createdAt.toISOString(),
    })),
    page,
    pageSize: safePageSize,
    total,
    totalPages: Math.ceil(total / safePageSize),
  }
}

/** DiceBear 头像 URL 模板（9.x） */
function dicebearAvatarUrl(style: string, seed: string): string {
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`
}

/**
 * 更新当前用户的 DiceBear 头像风格。
 * 把对应 DiceBear URL 写入 avatar 字段；TG 照片会被覆盖。
 * @param userId 用户 ID
 * @param style DiceBear 风格名
 * @param seed 可选种子，默认用用户名；传自定义种子可在同风格下切换不同头像
 * @returns 更新后的用户公开信息
 */
export async function updateAvatar(userId: number, style: string, seed?: string): Promise<UserPublic> {
  if (!ALLOWED_AVATAR_STYLES.includes(style as any)) {
    throw new ValidationError(
      `不支持的头像风格: ${style}，可选值: ${ALLOWED_AVATAR_STYLES.join(', ')}`,
      ErrorCode.VALIDATION_ERROR,
    )
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
  if (!user) {
    throw new NotFoundError('用户', ErrorCode.NOT_FOUND)
  }

  const avatarUrl = dicebearAvatarUrl(style, seed ?? user.username)

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatar: avatarUrl },
    select: {
      id: true,
      username: true,
      email: true,
      avatar: true,
      bio: true,
      level: true,
      points: true,
      stars: true,
      role: true,
      oauthProvider: true,
      createdAt: true,
    },
  })

  return updated
}
