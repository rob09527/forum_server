import { prisma } from '../../lib/prisma.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { NotFoundError, ValidationError, ForbiddenError } from '../../utils/errors.js'
import { levelProgress } from '../points/points.service.js'
import type { LevelProgress } from '../points/points.service.js'
import { getLevels } from '../config/config.service.js'
import { ALLOWED_AVATAR_STYLES, AVATARS_PER_STYLE } from '../../constants/business.js'
import type { UserStatusType } from '../../constants/business.js'
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
  /** 鸡腿余额（可花费）。仅本人可见，陌生人返回 null */
  points: number | null
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

/** 最新注册用户项（侧边栏「欢迎新用户」展示用） */
export interface NewUserItem {
  /** 用户 ID */
  id: number
  /** 用户名 */
  username: string
  /** 头像 URL，null 时前端用默认头像 */
  avatar: string | null
  /** 注册时间，ISO 8601 */
  createdAt: string
}

/**
 * 最新注册用户 Top N（按注册时间倒序），侧边栏「欢迎新用户」模块用。
 */
export async function getLatestUsers(limit = 8): Promise<NewUserItem[]> {
  const take = Math.min(50, Math.max(1, limit))

  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, username: true, avatar: true, createdAt: true },
  })

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    createdAt: u.createdAt.toISOString(),
  }))
}

/** 查询用户公开资料。viewerId 为当前登录用户，鸡腿余额仅本人可见（陌生人返回 null）。 */
export async function getUserProfile(userId: number, viewerId?: number): Promise<UserProfile> {
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

  // 等级以累计鸡腿实时计算为准（[R20][R21]），不信任可能过期的 DB 冗余字段；
  // 门槛来自后台配置（Redis，未配置走默认值），传 levels 计算
  const progress = levelProgress(user.totalPointsEarned, await getLevels())

  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    bio: user.bio,
    level: progress.level,
    points: viewerId === userId ? user.points : null,
    totalPointsEarned: user.totalPointsEarned,
    stars: user.stars,
    postCount: user.postCount,
    commentCount: user.commentCount,
    createdAt: user.createdAt.toISOString(),
    levelProgress: progress,
  }
}

/** 分页查询用户积分流水，按时间倒序。仅本人可见（viewerId 非本人抛 403）。 */
export async function getUserPointsLog(
  userId: number,
  viewerId: number,
  page = 1,
  pageSize = 20,
): Promise<Paginated<PointLogItem>> {
  if (viewerId !== userId) {
    throw new ForbiddenError('积分流水仅本人可见')
  }

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

/** 本地预置头像路径格式：/avatars/{style}/avatar-{nn}.svg */
const LOCAL_AVATAR_RE = /^\/avatars\/([a-z0-9-]+)\/avatar-(\d{2})\.svg$/

/**
 * 更新当前用户的头像为本地预置头像（无外网依赖）。
 * @param userId 用户 ID
 * @param avatar 本地头像路径，如 /avatars/bottts-neutral/avatar-03.svg
 * @returns 更新后的用户公开信息
 */
export async function updateAvatar(userId: number, avatar: string): Promise<UserPublic> {
  const m = LOCAL_AVATAR_RE.exec(avatar)
  const index = m ? Number(m[2]) : 0
  if (!m || !ALLOWED_AVATAR_STYLES.includes(m[1] as any) || index < 1 || index > AVATARS_PER_STYLE) {
    throw new ValidationError(
      `无效的头像路径: ${avatar}，格式应为 /avatars/{风格}/avatar-01~${String(AVATARS_PER_STYLE).padStart(2, '0')}.svg`,
      ErrorCode.VALIDATION_ERROR,
    )
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) {
    throw new NotFoundError('用户', ErrorCode.NOT_FOUND)
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatar },
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
      status: true,
      oauthProvider: true,
      createdAt: true,
    },
  })

  return { ...updated, status: updated.status as UserStatusType }
}
