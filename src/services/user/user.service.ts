import { prisma } from '../../lib/prisma.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { NotFoundError, ValidationError, ForbiddenError } from '../../utils/errors.js'
import { levelProgress } from '../points/points.service.js'
import type { LevelProgress } from '../points/points.service.js'
import { getLevels, getLimitsConfig } from '../config/config.service.js'
import { UserStatus } from '../../constants/business.js'
import { UploadPartition, UPLOAD_URL_ROOT } from '../../constants/upload-paths.js'
import { AvatarPathKind, assertAllowedAvatarPath, enforceUploadedAvatarLimits } from '../../utils/avatar.js'
import { consumePendingAvatar, restorePendingAvatar, finalizePendingAvatar, cleanupReplacedAvatar } from '../upload/upload.service.js'
import type { UserStatusType } from '../../constants/business.js'
import type { UserPublic } from '../auth/auth.service.js'
import { USER_PUBLIC_SELECT } from '../auth/auth.service.js'
import { findPlaceholderUserId } from '../import/shadow-users.js'

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
  /** 粉丝数（冗余字段） */
  followerCount: number
  /** 关注数（冗余字段） */
  followingCount: number
  /** 当前登录用户是否已关注该用户（viewerId 未登录或为自己时为 false） */
  isFollowing: boolean
  /** 注册时间，ISO 8601 */
  createdAt: string
  /** 等级进度：下一等级门槛 + 还差多少 [R21] */
  levelProgress: LevelProgress
  /** 生效中的用户名颜色渲染值；null 或已过期则不上色 [1.3.7] */
  decorColorValue: string | null
  /** 用户名颜色到期时间 */
  decorColorExpireAt: Date | null
  /** 生效中的称号文本；null 或已过期则无称号 */
  decorTitleValue: string | null
  /** 称号徽章配色 key，与 decorTitleValue 成对存储 */
  decorTitleStyle: string | null
  /** 称号到期时间 */
  decorTitleExpireAt: Date | null
}

/** 积分流水项 */
export interface PointLogItem {
  /** 流水 ID */
  id: number
  /** 积分来源：checkin | post | comment | liked | shop | tip_out | bounty_out … */
  type: string
  /** 变动值（带符号：收入为正，消费/支出为负） */
  delta: number
  /** 变动后鸡腿余额 [R42] */
  balanceAfter: number
  /** 关联帖子/评论 ID，无关联为 null */
  refId: number | null
  /** 变动时间，ISO 8601 */
  createdAt: string
}

/** 积分流水分页结果：在分页基础上附带资产总览（不随筛选/页码变化） */
export interface PointsLogResult extends Paginated<PointLogItem> {
  /** 累计获得（等级口径 totalPointsEarned，只增不减）：供「累计获得」展示，避免前端另发 profile 请求 */
  totalEarned: number
  /** 收入合计：全量正向流水之和（签到/发帖/评论/被赞/打赏入账/悬赏奖励/退款等） */
  totalIncome: number
  /** 支出合计：全量负向流水之和的绝对值（店铺消费/打赏支出/悬赏支出等），恒为非负 */
  totalExpense: number
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
 * 只取本站真实注册的 active 用户：
 * - isShadow=false：导入的影子用户 createdAt = 其在对方站首次发言时间，而回填是从最新页往回走，
 *   活跃影子会被赋上「最近几天」的注册时间，不排除会把「欢迎新用户」整块刷爆（终局 3 万影子 vs 几百真人）。
 * - status=active：封禁/禁言账号不该出现在欢迎位。
 * 走 users(isShadow, createdAt DESC) 复合索引：isShadow 等值前缀 + createdAt 有序后缀，免排序回表；
 * status=active 是附加过滤（不纳入该索引前缀，真人量级小可接受）。
 */
export async function getLatestUsers(limit = 8): Promise<NewUserItem[]> {
  const take = Math.min(50, Math.max(1, limit))

  const users = await prisma.user.findMany({
    where: { isShadow: false, status: UserStatus.ACTIVE },
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

/** 用户搜索项（@提及候选下拉用） */
export interface UserSearchItem {
  /** 用户 ID */
  id: number
  /** 用户名 */
  username: string
  /** 头像 URL，null 时前端用默认头像 */
  avatar: string | null
  /** 用户等级 */
  level: string
}

/** @提及候选单次最多返回条数 */
const MENTION_SEARCH_LIMIT = 20

/**
 * 按用户名前缀搜索 active 用户（@提及候选）。
 * 前缀匹配 + 大小写不敏感（ILIKE 'q%'）：当前用户量级下走全表扫描足够快；
 * 若用户量增长到扫描吃力，再给 username 建 pg_trgm GIN 索引支持中缀模糊（届时需迁移）。
 *
 * 影子用户（导入账号）的口径（产品已拍）：
 * - 允许被 @：@ 一个导入作者能形成引用语义，有价值，所以不过滤。
 * - 但真人优先：终局 3 万影子 vs 几百真人，字典序单排会让真人被挤出前 20，
 *   故按 isShadow 升序（false < true）做首要排序键，真人先占满候选位。
 * - 占位账号「已注销用户」例外剔除：@ 一个已注销用户没有任何意义。
 */
export async function searchUsers(
  q: string,
  limit = MENTION_SEARCH_LIMIT,
): Promise<UserSearchItem[]> {
  const keyword = q?.trim() ?? ''
  if (keyword.length === 0) {
    return []
  }

  // 按 id 剔除占位账号，而不是比对用户名字符串（占位账号改名后字符串判定会静默失效）
  const placeholderId = await findPlaceholderUserId()

  const take = Math.min(MENTION_SEARCH_LIMIT, Math.max(1, limit))
  const users = await prisma.user.findMany({
    where: {
      username: { startsWith: keyword, mode: 'insensitive' },
      status: UserStatus.ACTIVE,
      ...(placeholderId !== null ? { id: { not: placeholderId } } : {}),
    },
    orderBy: [{ isShadow: 'asc' }, { username: 'asc' }],
    take,
    select: {
      id: true,
      username: true,
      avatar: true,
      level: true,
    },
  })

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    level: u.level,
  }))
}

/**
 * 改名用户名可用性检查（与 props.service.rename 的查重同口径：精确匹配）。
 * excludeUserId 为当前用户 ID：改名时排除自己，避免把自己的现名判为占用。
 * 返回 true 表示可用。供前端改名弹窗「实时唯一性提示」[3.6]。
 */
export async function checkUsernameAvailable(
  username: string,
  excludeUserId?: number,
): Promise<boolean> {
  const name = username?.trim() ?? ''
  if (!name) return false
  const existing = await prisma.user.findFirst({
    where: {
      username: name,
      ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}),
    },
    select: { id: true },
  })
  return existing === null
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
      followerCount: true,
      followingCount: true,
      createdAt: true,
      decorColorValue: true,
      decorColorExpireAt: true,
      decorTitleValue: true,
      decorTitleStyle: true,
      decorTitleExpireAt: true,
    },
  })
  if (!user) {
    throw new NotFoundError('用户', ErrorCode.NOT_FOUND)
  }

  // 等级以累计鸡腿实时计算为准（[R20][R21]），不信任可能过期的 DB 冗余字段；
  // 门槛来自后台配置（Redis，未配置走默认值），传 levels 计算
  const progress = levelProgress(user.totalPointsEarned, await getLevels())

  // 关注态：仅当「他人视角」才查询（自己看自己不显示关注按钮，无需查库）
  let isFollowing = false
  if (viewerId && viewerId !== userId) {
    const f = await prisma.follow.findUnique({
      where: { followerId_followeeId: { followerId: viewerId, followeeId: userId } },
      select: { id: true },
    })
    isFollowing = f !== null
  }

  return {
    id: user.id,
    username: user.username,
    // 头像折叠：租用头像未过期优先，否则基础头像
    avatar: user.avatar,
    bio: user.bio,
    level: progress.level,
    points: viewerId === userId ? user.points : null,
    totalPointsEarned: user.totalPointsEarned,
    stars: user.stars,
    postCount: user.postCount,
    commentCount: user.commentCount,
    followerCount: user.followerCount,
    followingCount: user.followingCount,
    isFollowing,
    createdAt: user.createdAt.toISOString(),
    levelProgress: progress,
    decorColorValue: user.decorColorValue,
    decorColorExpireAt: user.decorColorExpireAt,
    decorTitleValue: user.decorTitleValue,
    decorTitleStyle: user.decorTitleStyle,
    decorTitleExpireAt: user.decorTitleExpireAt,
  }
}

/** 积分流水收支类型筛选：income=仅正向，expense=仅负向，不传=全部 */
export type PointsLogFilter = 'income' | 'expense'

/** 分页查询用户积分流水，按时间倒序。仅本人可见（viewerId 非本人抛 403）。 */
export async function getUserPointsLog(
  userId: number,
  viewerId: number,
  page = 1,
  pageSize = 20,
  filter?: PointsLogFilter,
): Promise<PointsLogResult> {
  if (viewerId !== userId) {
    throw new ForbiddenError('积分流水仅本人可见')
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, totalPointsEarned: true } })
  if (!user) {
    throw new NotFoundError('用户', ErrorCode.NOT_FOUND)
  }

  // 页码/页大小/筛选参数校验：非法值抛校验错误（避免 skip: NaN 导致 500）
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError('页码必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('每页条数必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  const safePageSize = Math.min(50, pageSize)
  // 列表的 delta 方向条件由筛选决定（income>0 / expense<0 / 全部）
  const deltaCond = filter === 'income' ? { delta: { gt: 0 } } : filter === 'expense' ? { delta: { lt: 0 } } : {}
  const where = { userId, ...deltaCond }

  // 收支合计：永远统计全部流水（不随 type 筛选/页码变化），供资产总览展示。
  // 注意不能用「totalPointsEarned - balance」推导——creditPoints 通道(打赏入账/悬赏退款)只加余额不累计，会算出差值失真。
  const [total, rows, incomeAgg, expenseAgg] = await Promise.all([
    prisma.pointLog.count({ where }),
    prisma.pointLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * safePageSize,
      take: safePageSize,
    }),
    prisma.pointLog.aggregate({ where: { userId, delta: { gt: 0 } }, _sum: { delta: true } }),
    prisma.pointLog.aggregate({ where: { userId, delta: { lt: 0 } }, _sum: { delta: true } }),
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
    totalEarned: user.totalPointsEarned,
    totalIncome: incomeAgg._sum.delta ?? 0,
    totalExpense: Math.abs(expenseAgg._sum.delta ?? 0),
  }
}

/**
 * 更新当前用户的头像（§9.1 拆除「头像是付费商品」这道闸门后的形态）。
 *
 * 头像来源两条、**都免费**：
 * 1. 本地预置模板 `/avatars/{风格}/avatar-NN.svg` —— 任选，不再需要在商城解锁；
 * 2. 用户自定义上传 `/uploads/avatars/xxx` —— 先走通用 `POST /api/upload` 拿到相对路径，
 *    再调本接口落库；体积/像素上限在此**服务端**强制（绕过前端直接 POST 也拦得住）。
 *
 * 合法性一律由 `assertAllowedAvatarPath` 的白名单二选一判定，⛔ 禁止「任意字符串直存」——
 * 那等于开放任意外链注入到所有用户的头像位（SSRF / 追踪像素 / 站外图挂载）。
 * 落库同时把已下线的租用覆盖层 `decorAvatarValue/ExpireAt` 置 null（两列已是死列，见 schema 注释）。
 *
 * @param userId 用户 ID
 * @param avatar 头像相对路径（预置模板或站内上传，二选一）
 * @returns 更新后的用户公开信息
 */
export async function updateAvatar(userId: number, avatar: string): Promise<UserPublic> {
  const kind = assertAllowedAvatarPath(avatar)

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) {
    throw new NotFoundError('用户', ErrorCode.NOT_FOUND)
  }

  let pendingSize: number | null = null
  if (kind === AvatarPathKind.UPLOADED) {
    pendingSize = await consumePendingAvatar(avatar, userId)
    if (pendingSize === null) {
      throw new ValidationError('头像上传已过期或不属于当前用户，请重新上传', ErrorCode.VALIDATION_ERROR)
    }
  }

  let finalSize = pendingSize
  let committed = false
  try {
    if (kind === AvatarPathKind.UPLOADED) {
      finalSize = await enforceUploadedAvatarLimits(avatar)
    }

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { avatar: true, uploadSize: true, uploadQuotaBonus: true },
      })
      if (!current) throw new NotFoundError('用户', ErrorCode.NOT_FOUND)

      if (kind === AvatarPathKind.UPLOADED && finalSize !== null) {
        const limits = await getLimitsConfig()
        const effectiveLimit = limits.uploadMaxUserTotalSize + current.uploadQuotaBonus
        // 用带条件的原子更新守住并发确认：先查再 increment 会让两个请求同时越过总量上限。
        const claimed = await tx.user.updateMany({
          where: { id: userId, uploadSize: { lte: effectiveLimit - finalSize } },
          data: { uploadSize: { increment: finalSize } },
        })
        if (claimed.count !== 1) {
          throw new ValidationError('上传总量已达上限', ErrorCode.UPLOAD_USER_TOTAL_EXCEEDED)
        }
      }

      const updated = await tx.user.update({
        where: { id: userId },
        data: { avatar, decorAvatarValue: null, decorAvatarExpireAt: null },
        select: USER_PUBLIC_SELECT,
      })
      return { updated, previousAvatar: current.avatar }
    })

    // 数据库已提交后，pending 只剩清理职责；清理失败不能回滚已生效的头像，
    // 否则 catch 会重新登记一个已经被引用的资源，增加索引残留。
    committed = true
    if (kind === AvatarPathKind.UPLOADED && finalSize !== null) {
      await finalizePendingAvatar(avatar, userId, pendingSize ?? finalSize).catch((err) => {
        // sweepPendingAvatars 会通过 DB 引用兜底移除索引并保留文件；这里保留日志便于排查 Redis 故障。
        console.error('[user] finalize pending avatar failed:', avatar, err)
      })
    }
    if (updated.previousAvatar && updated.previousAvatar !== avatar) {
      await cleanupReplacedAvatar(
        updated.previousAvatar,
        userId,
        updated.previousAvatar.startsWith(`${UPLOAD_URL_ROOT}/${UploadPartition.AVATARS}/`),
      ).catch((err) => console.error('[user] cleanup replaced avatar failed:', updated.previousAvatar, err))
    }
    return { ...updated.updated, status: updated.updated.status as UserStatusType }
  } catch (err: unknown) {
    if (kind === AvatarPathKind.UPLOADED && pendingSize !== null && !committed) {
      await restorePendingAvatar(avatar, userId, pendingSize).catch(() => undefined)
    }
    throw err
  }
}
