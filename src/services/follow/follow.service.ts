import { prisma } from '../../lib/prisma.js'
import { ErrorCode } from '../../constants/error-codes.js'
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from '../../utils/errors.js'
import { NotificationType } from '../../constants/business.js'
import { createAndPush } from '../notification/notification.service.js'
import { toListItem } from '../post/post-formatter.js'
import type { PostListItem } from '../post/post-formatter.js'
import { AUTHOR_SELECT, toAuthorBrief, type AuthorRow } from '../user/user-decorator.js'

/**
 * 关注服务。
 * 单向 follow（Twitter 式）：follower 关注 followee，对方无需回关。
 * 幂等：唯一约束 (followerId, followeeId)；关注后给被关注者发 follow 通知（排除关注自己，已在入口拦截）。
 * 计数：follow 表 + User.followerCount/followingCount 冗余同步（避免 COUNT），同事务保证一致。
 */

/** 关注列表项（目标用户摘要） */
export interface FollowUserItem {
  /** 用户 ID */
  id: number
  /** 用户名 */
  username: string
  /** 头像 URL，null 时前端用默认头像 */
  avatar: string | null
  /** 用户等级：claw | leg | meat */
  level: string
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

/** 分页结果 */
export interface Paginated<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/** 关注用户，返回是否首次关注（已关注则抛冲突） */
export async function followUser(followeeId: number, followerId: number): Promise<void> {
  if (followeeId === followerId) {
    throw new ValidationError('不能关注自己', ErrorCode.CANNOT_FOLLOW_SELF)
  }

  const followee = await prisma.user.findUnique({
    where: { id: followeeId },
    select: { id: true },
  })
  if (!followee) {
    throw new NotFoundError('用户', ErrorCode.NOT_FOUND)
  }

  try {
    // 「写入关系 + 双方计数 +1」同事务，避免关系在但计数没加
    await prisma.$transaction(async (tx) => {
      await tx.follow.create({ data: { followerId, followeeId } })
      await Promise.all([
        tx.user.update({
          where: { id: followerId },
          data: { followingCount: { increment: 1 } },
        }),
        tx.user.update({
          where: { id: followeeId },
          data: { followerCount: { increment: 1 } },
        }),
      ])
    })
  } catch (err) {
    // 并发下重复关注 → 唯一约束 P2002 兜底（对齐 like.service 的 isUniqueViolation 写法）
    if (isUniqueViolation(err)) {
      throw new ConflictError('已经关注过了', ErrorCode.ALREADY_FOLLOWING)
    }
    throw err
  }

  // 通知被关注者（fire-and-forget，非关键路径失败不阻塞）
  createAndPush({
    userId: followeeId,
    type: NotificationType.FOLLOW,
    actorId: followerId,
  })
}

/** 取消关注，双方计数 -1（幂等，未关注时抛冲突） */
export async function unfollowUser(followeeId: number, followerId: number): Promise<void> {
  // 「删除关系 + 双方计数 -1」同事务，避免删了但计数没减；未关注时抛冲突（事务回滚）
  await prisma.$transaction(async (tx) => {
    const deleted = await tx.follow.deleteMany({
      where: { followerId, followeeId },
    })
    if (deleted.count === 0) {
      throw new ConflictError('还没关注，无法取关', ErrorCode.NOT_FOLLOWING)
    }
    await Promise.all([
      tx.user.update({
        where: { id: followerId },
        data: { followingCount: { decrement: 1 } },
      }),
      tx.user.update({
        where: { id: followeeId },
        data: { followerCount: { decrement: 1 } },
      }),
    ])
  })
}

/** 分页查询「某人关注的人」（关注列表） */
export async function listFollowing(
  userId: number,
  page = 1,
  pageSize = 20,
): Promise<Paginated<FollowUserItem>> {
  return listRelations(userId, page, pageSize, 'followee')
}

/** 分页查询「关注某人的人」（粉丝列表） */
export async function listFollowers(
  userId: number,
  page = 1,
  pageSize = 20,
): Promise<Paginated<FollowUserItem>> {
  return listRelations(userId, page, pageSize, 'follower')
}

/**
 * 关注动态流：被关注者发布的新帖按时间倒序分页。
 * 用关系过滤生成 EXISTS 子查询（作者被 userId 关注），
 * 避免全量拉取关注列表进内存拼大 IN 子句；更大规模可再演进 Redis feed。
 */
export async function getFollowingFeed(
  userId: number,
  page = 1,
  pageSize = 20,
): Promise<Paginated<PostListItem>> {
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError('页码必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('每页条数必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  const safePageSize = Math.min(50, pageSize)

  // author.followers.some{followerId} ⇔ EXISTS (SELECT 1 FROM follows
  // WHERE followeeId = posts.authorId AND followerId = userId)，关注列表不物化进内存
  const where = {
    author: {
      followers: { some: { followerId: userId } },
    },
  }
  const [total, posts] = await Promise.all([
    prisma.post.count({ where }),
    prisma.post.findMany({
      where,
      include: {
        author: { select: AUTHOR_SELECT },
      },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * safePageSize,
      take: safePageSize,
    }),
  ])

  return {
    items: posts.map((p) => toListItem(p)),
    page,
    pageSize: safePageSize,
    total,
    totalPages: Math.ceil(total / safePageSize),
  }
}

/** 单条判断：follower 是否已关注 followee（用户主页按钮态） */
export async function isFollowing(followerId: number, followeeId: number): Promise<boolean> {
  const row = await prisma.follow.findUnique({
    where: { followerId_followeeId: { followerId, followeeId } },
    select: { id: true },
  })
  return row !== null
}

/** 关注/粉丝列表的关联用户摘要（followee/follower 同构） */
interface RelationTargetUser extends AuthorRow {}

/** 关注/粉丝列表共用查询。relation 为 'followee'（关注列表）或 'follower'（粉丝列表） */
async function listRelations(
  userId: number,
  page: number,
  pageSize: number,
  relation: 'followee' | 'follower',
): Promise<Paginated<FollowUserItem>> {
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError('页码必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('每页条数必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  const safePageSize = Math.min(50, pageSize)

  // userId 是关注者 → 关注列表查 followee；userId 是被关注者 → 粉丝列表查 follower
  const selfField = relation === 'followee' ? 'followerId' : 'followeeId'

  const [total, rows] = await Promise.all([
    prisma.follow.count({ where: { [selfField]: userId } }),
    prisma.follow.findMany({
      where: { [selfField]: userId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * safePageSize,
      take: safePageSize,
      include: {
        // 动态 include key（computed 属性）会让 TS 把 r[relation] 推断成 never，这里显式断言
        [relation]: {
          select: AUTHOR_SELECT,
        },
      },
    }),
  ])

  return {
    items: rows.map((r) => {
      const u = r[relation] as RelationTargetUser
      return toAuthorBrief(u)
    }),
    page,
    pageSize: safePageSize,
    total,
    totalPages: Math.ceil(total / safePageSize),
  }
}

/** 判断是否为 Prisma 唯一约束冲突错误 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002'
}
