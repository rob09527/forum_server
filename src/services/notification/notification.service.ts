import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, ValidationError } from '../../utils/errors.js'
import { ErrorCode } from '../../constants/error-codes.js'
import {
  NotificationType,
  SystemNotifyTarget,
  UserStatus,
} from '../../constants/business.js'
import type { SystemNotifyTargetType, NotificationTypeType } from '../../constants/business.js'
import { redis, RedisKey } from '../../lib/redis.js'
import { pushToUser, pushToAllOnline } from '../realtime/sse.js'
import { extractMentionedUserIds } from '../../utils/mention.js'

/**
 * 站内通知服务。
 *
 * 设计原则：
 * - 通知是非关键路径：业务动作（发评论/点赞/关注）完成后 fire-and-forget 调用
 *   createAndPush，失败只记日志、不阻塞主业务（对齐 meilisearch 索引的 indexPost 模式）。
 * - like 类通知聚合：同一目标（帖子/评论）的多个点赞者合并为一条通知、actor 累加，
 *   未读期间重复点赞只是追加 actorId + 刷新时间，不产生新记录。
 * - 排除自己给自己发通知：业务动作触发点在调用方判断「触发者 ≠ 接收者」。
 */

/** 通知触发者摘要 */
export interface NotificationActor {
  /** 用户 ID */
  id: number
  /** 用户名 */
  username: string
  /** 头像 URL，null 时前端用默认头像 */
  avatar: string | null
}

/** 通知项（列表/推送共用） */
export interface NotificationItem {
  /** 通知 ID */
  id: number
  /** comment | reply | like | follow | system | mention */
  type: string
  /** 触发者列表（最多 3 个，聚合通知只留最近触发者；system 为空数组） */
  actors: NotificationActor[]
  /** 触发者总数（聚合累计事件数，actorIds 截断后的真实人数/次数看这里） */
  actorCount: number
  /** 关联帖子 ID，帖子已删或无关为 null */
  postId: number | null
  /** 帖子标题，帖子已删或无关为 null */
  postTitle: string | null
  /** 关联评论 ID */
  commentId: number | null
  /** 评论内容截断（reply/like-comment 用），已删或无关为 null */
  commentExcerpt: string | null
  /** 通知正文（system 用） */
  content: string | null
  /** 是否已读 */
  isRead: boolean
  /** 通知时间，ISO 8601 */
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

/** 创建通知的入参 */
export interface CreateNotificationInput {
  /** 接收者 ID */
  userId: number
  /** 通知类型 */
  type: NotificationTypeType
  /** 触发者 ID（system 不传） */
  actorId?: number
  /** 关联帖子 ID */
  postId?: number | null
  /** 关联评论 ID */
  commentId?: number | null
  /** 通知正文（system 用） */
  content?: string | null
}

/** 评论内容在通知列表里的展示截断长度 */
const COMMENT_EXCERPT_LENGTH = 60

/**
 * 创建通知（内部方法，含 like 聚合）。
 * 返回创建/更新的通知记录（仅基础字段），供推送使用。
 */
export async function createNotification(
  input: CreateNotificationInput,
  tx?: Prisma.TransactionClient,
): Promise<{ id: number; type: string; created: boolean }> {
  const db = tx ?? prisma
  const { userId, type, actorId, postId, commentId, content } = input
  const hasActor = actorId !== undefined && actorId !== null

  // 聚合通知：同一「目标」在未读期间合并为一条、actor 累加，追加 actor + 刷新时间置顶。
  // 聚合键按类型区分：
  // - like    → 同一帖子/评论的未读点赞聚合（commentId 优先，无则 postId）
  // - follow  → 同一接收者的未读关注聚合（无目标维度，仅 userId + type）
  // - comment → 同一帖子的未读顶层评论聚合（reply 楼中楼不聚合，保持逐条）
  // 并发下可能产生重复通知（两条并列的未读同类通知），属可接受的非关键误差，不做悲观锁。
  const aggregateKey: Record<string, unknown> | null = (() => {
    switch (type) {
      case NotificationType.LIKE:
      // [2.3] TIP 与 LIKE 同款聚合：同一帖子/评论的未读打赏合并一条、actor 累加 →「张三等 3 人打赏了你的帖子」
      case NotificationType.TIP:
        return commentId !== undefined && commentId !== null
          ? { commentId }
          : { postId: postId ?? null }
      case NotificationType.FOLLOW:
        return {}
      case NotificationType.COMMENT:
      // [2.3] 悬赏三态通知同帖合并：同帖多次新回答/结算/退款提醒聚合为一条、actor 累加
      case NotificationType.BOUNTY_REPLY:
      case NotificationType.BOUNTY_SETTLED:
      case NotificationType.BOUNTY_REFUNDED:
        return { postId: postId ?? null }
      default:
        // reply / system 不聚合：reply 每条独立线程，system 由广播批量落库不走此路径
        return null
    }
  })()

  // 聚合分支要求带 actor（like/follow/comment 触发者必有；system 不走此路径）
  if (aggregateKey && hasActor) {
    const existing = await db.notification.findFirst({
      where: {
        userId,
        type,
        isRead: false,
        ...aggregateKey,
      },
      orderBy: { createdAt: 'desc' },
    })

    if (existing) {
      // actorIds 去重 + 只保留最近 3 个（防无界数组整列重写 O(n²)），
      // actorCount 累加记总数，前端「X、Y 等 N 人」的 N 取自 actorCount
      const nextActors = [...new Set([...existing.actorIds, actorId])].slice(-3)
      const updated = await db.notification.update({
        where: { id: existing.id },
        data: {
          actorIds: nextActors,
          actorCount: { increment: 1 },
          createdAt: new Date(),
        },
        select: { id: true, type: true },
      })
      return { ...updated, created: false }
    }
  }

  const created = await db.notification.create({
    data: {
      userId,
      type,
      actorIds: hasActor ? [actorId] : [],
      actorCount: hasActor ? 1 : 0,
      postId: postId ?? null,
      commentId: commentId ?? null,
      content: content ?? null,
    },
    select: { id: true, type: true },
  })
  return { ...created, created: true }
}

/**
 * 创建通知并推送 SSE（业务动作的 fire-and-forget 入口）。
 * 失败只记日志，不抛给调用方（通知非关键路径）。
 */
export function createAndPush(input: CreateNotificationInput): void {
  ;(async () => {
    try {
      const created = await createNotification(input)
      const unread = await refreshUnread(input.userId, created.created)
      pushToUser(input.userId, 'notification', {
        notification: created,
        unreadCount: unread,
      })
    } catch (err) {
      console.error(`[notification] create & push failed (type=${input.type}):`, err)
    }
  })()
}

/** @提及通知入参 */
export interface NotifyMentionsInput {
  /** 提及内容（Markdown），从中解析结构化 mention 链接 */
  content: string
  /** 触发者 ID（发帖/评论作者） */
  actorId: number
  /** 关联帖子 ID */
  postId: number
  /** 关联评论 ID（发帖场景不传） */
  commentId?: number | null
  /** 不通知的用户 ID（如帖子作者、被回复者） */
  excludeIds?: number[]
}

/**
 * 解析内容中的 @提及并向被提及用户发通知（fire-and-forget，非关键路径）。
 * 与 createAndPush 同一哲学：失败只记日志、不阻塞主业务。
 * - 只识别结构化链接 [@名](/user/id)，id 非法/缺失的跳过。
 * - 查库确认目标存在且 active（防恶意 @ 不存在的 id 刷脏数据/空通知）。
 * - 排除 excludeIds 与触发者自己（避免与评论/回复通知重复打扰同一人）。
 */
export function notifyMentions(input: NotifyMentionsInput): void {
  ;(async () => {
    try {
      const ids = extractMentionedUserIds(input.content)
      if (ids.length === 0) return

      // 排除自己 + 调用方指定不通知的人，再查库，减少无谓查询
      const excluded = new Set<number>([input.actorId, ...(input.excludeIds ?? [])])
      const targetIds = ids.filter((id) => !excluded.has(id))
      if (targetIds.length === 0) return

      const targets = await prisma.user.findMany({
        where: { id: { in: targetIds }, status: UserStatus.ACTIVE },
        select: { id: true },
      })

      for (const user of targets) {
        createAndPush({
          userId: user.id,
          type: NotificationType.MENTION,
          actorId: input.actorId,
          postId: input.postId,
          commentId: input.commentId ?? null,
        })
      }
    } catch (err) {
      console.error(`[notification] notify mentions failed (postId=${input.postId}):`, err)
    }
  })()
}

/**
 * 事件后刷新未读数（Redis 计数器，避免每事件 COUNT(*)）：
 * - 新增行（created=true）→ 缓存命中则 INCR +1；miss 则 COUNT 对账回填（COUNT 已含新行）。
 * - 聚合更新（created=false，行数未变）→ 读缓存即可，miss 兜底 COUNT。
 * 返回最新未读数供 SSE 推送。
 */
async function refreshUnread(userId: number, isNew: boolean): Promise<number> {
  if (isNew) {
    if ((await redis.exists(RedisKey.unreadCount(userId))) === 1) {
      return redis.incr(RedisKey.unreadCount(userId))
    }
  }
  return unreadCount(userId)
}

/**
 * 分页查询用户通知（按时间倒序），组装触发者摘要 + 关联帖子标题/评论截断。
 * 帖子/评论被删后关联信息为 null，前端兜底显示「内容已删除」。
 */
export async function listNotifications(
  userId: number,
  page = 1,
  pageSize = 20,
): Promise<Paginated<NotificationItem>> {
  // 页码/页大小校验：非法值抛校验错误（避免 skip: NaN 导致 500）
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError('页码必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('每页条数必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  const safePageSize = Math.min(50, pageSize)

  const [total, rows] = await Promise.all([
    prisma.notification.count({ where: { userId } }),
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * safePageSize,
      take: safePageSize,
    }),
  ])

  // 收集关联 ID 一次性批量查询，避免 N+1
  const actorIds = [...new Set(rows.flatMap((r) => r.actorIds))]
  const postIds = [...new Set(rows.map((r) => r.postId).filter((id): id is number => id !== null))]
  const commentIds = [...new Set(rows.map((r) => r.commentId).filter((id): id is number => id !== null))]
  // system 群发通知：正文存于 notification_messages 表，按 messageId 批量取回（逐行不冗余）
  const messageIds = [...new Set(rows.map((r) => r.messageId).filter((id): id is number => id !== null))]

  const [actors, posts, comments, messages] = await Promise.all([
    actorIds.length
      ? prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, username: true, avatar: true },
        })
      : Promise.resolve(
          [] as { id: number; username: string; avatar: string | null }[],
        ),
    postIds.length
      ? prisma.post.findMany({
          where: { id: { in: postIds } },
          select: { id: true, title: true },
        })
      : Promise.resolve([] as { id: number; title: string }[]),
    commentIds.length
      ? prisma.comment.findMany({
          where: { id: { in: commentIds } },
          select: { id: true, content: true },
        })
      : Promise.resolve([] as { id: number; content: string }[]),
    messageIds.length
      ? prisma.notificationMessage.findMany({
          where: { id: { in: messageIds } },
          select: { id: true, content: true },
        })
      : Promise.resolve([] as { id: number; content: string }[]),
  ])

  const actorMap = new Map(
    actors.map((a) => [a.id, { id: a.id, username: a.username, avatar: a.avatar }]),
  )
  const postMap = new Map(posts.map((p) => [p.id, p]))
  const commentMap = new Map(comments.map((c) => [c.id, c]))
  const messageMap = new Map(messages.map((m) => [m.id, m.content]))

  const items: NotificationItem[] = rows.map((r) => {
    const comment = r.commentId !== null ? commentMap.get(r.commentId) : undefined
    return {
      id: r.id,
      type: r.type,
      actors: r.actorIds
        .map((id) => actorMap.get(id))
        .filter((a): a is NotificationActor => a !== undefined),
      // 触发者总数（actorIds 只存最近 3 个，总数看 actorCount）
      actorCount: r.actorCount,
      postId: r.postId,
      postTitle: r.postId !== null ? postMap.get(r.postId)?.title ?? null : null,
      commentId: r.commentId,
      commentExcerpt: comment ? excerpt(comment.content) : null,
      // 新群发 content=null + messageId 指向消息表；存量行走 r.content 兜底
      content: r.messageId !== null ? (messageMap.get(r.messageId) ?? r.content) : r.content,
      isRead: r.isRead,
      createdAt: r.createdAt.toISOString(),
    }
  })

  return {
    items,
    page,
    pageSize: safePageSize,
    total,
    totalPages: Math.ceil(total / safePageSize),
  }
}

/** 未读通知数（顶栏红点 / SSE 推送用）。Redis 计数器优先，miss 时 COUNT 兜底回填。 */
export async function unreadCount(userId: number): Promise<number> {
  const cached = await redis.get(RedisKey.unreadCount(userId))
  if (cached !== null) {
    return Number(cached)
  }
  const count = await prisma.notification.count({ where: { userId, isRead: false } })
  await redis.set(RedisKey.unreadCount(userId), count)
  return count
}

/** 单条已读（仅本人可标记自己的通知） */
export async function markRead(id: number, userId: number): Promise<void> {
  const result = await prisma.notification.updateMany({
    where: { id, userId },
    data: { isRead: true },
  })
  if (result.count === 0) {
    throw new NotFoundError('通知', ErrorCode.NOTIFICATION_NOT_FOUND)
  }
  // 已读后失效未读缓存，下次读/写走 COUNT 对账，避免计数漂移
  await redis.del(RedisKey.unreadCount(userId))
}

/** 全部已读，返回标记条数 */
export async function markAllRead(userId: number): Promise<{ updated: number }> {
  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  })
  await redis.del(RedisKey.unreadCount(userId))
  return { updated: result.count }
}

/** 系统通知群发入参 */
export interface BroadcastInput {
  /** all(全部 active) | role(按角色) | users(指定用户列表) */
  target: SystemNotifyTargetType
  /** target=role 时的角色 */
  role?: string
  /** target=users 时的用户 ID 列表 */
  userIds?: number[]
  /** 通知正文 */
  content: string
  /** 跳转帖子 ID（可选） */
  postId?: number | null
}

/**
 * 系统通知群发（管理端，requireAdminKey 已鉴权）。
 * 按 target 解析接收者，createMany 批量写入 type=system 的通知，
 * 再对在线用户 fire-and-forget 推送 SSE（仅更新未读数）。
 */
export async function broadcastSystemNotification(
  input: BroadcastInput,
): Promise<{ sentCount: number }> {
  const content = input.content?.trim() ?? ''
  if (content.length < 1) {
    throw new ValidationError('通知内容不能为空', ErrorCode.VALIDATION_ERROR)
  }

  const postId = input.postId ?? null
  const BATCH_SIZE = 5000

  // ── target=users：管理端指定的有界列表，去重后分批（不物化全站） ──
  if (input.target === SystemNotifyTarget.USERS) {
    const userIds = [...new Set(input.userIds ?? [])]
    if (userIds.length === 0) {
      return { sentCount: 0 }
    }
    const message = await prisma.notificationMessage.create({
      data: { content, postId, sentCount: userIds.length },
    })
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const batch = userIds.slice(i, i + BATCH_SIZE)
      await prisma.notification.createMany({
        data: batch.map((userId) => systemRow(userId, message.id, postId)),
      })
      // 广播新增未读但未走 createAndPush 的 INCR，失效缓存避免计数漂移
      await invalidateUnreadBatch(batch)
    }
    // 只对在线接收者推 SSE（pushToUser 对离线用户是 O(1) Map 空查）
    for (const userId of userIds) {
      pushToUser(userId, 'notification', { type: 'system' })
    }
    return { sentCount: userIds.length }
  }

  // ── target=all / role：DB 条件 + 游标流式分批，不一次物化全部 ID ──
  // isShadow=false：影子用户是导入数据的作者载体（passwordHash=null，永远无法登录），
  // 给他们发公告会白写 3 万行 notifications，且回给后台的 sentCount 变成
  // 「触达 3 万人」的假指标，会误导运营决策。
  const userWhere: Prisma.UserWhereInput = { status: UserStatus.ACTIVE, isShadow: false }
  if (input.target === SystemNotifyTarget.ROLE) {
    if (!input.role) {
      throw new ValidationError('按角色群发需指定角色', ErrorCode.VALIDATION_ERROR)
    }
    userWhere.role = input.role
  }

  const sentCount = await prisma.user.count({ where: userWhere })
  if (sentCount === 0) {
    return { sentCount: 0 }
  }

  const message = await prisma.notificationMessage.create({
    data: { content, postId, sentCount },
  })

  // 游标分批：每次取 5000 个 id（lastId 严格递增推进），createMany 后失效该批未读缓存
  let lastId = 0
  let written = 0
  for (;;) {
    const rows = await prisma.user.findMany({
      where: { ...userWhere, id: { gt: lastId } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    })
    if (rows.length === 0) break
    lastId = rows[rows.length - 1].id
    const batchIds = rows.map((r) => r.id)
    await prisma.notification.createMany({
      data: batchIds.map((userId) => systemRow(userId, message.id, postId)),
    })
    await invalidateUnreadBatch(batchIds)
    written += batchIds.length
  }

  // 只推在线连接（在线 ⊂ 全部 active 接收者），不再遍历全部接收者
  pushToAllOnline('notification', { type: 'system' })

  return { sentCount: written }
}

/** system 通知行：正文存消息表（行内 content=null + messageId 引用），避免逐用户冗余 */
function systemRow(userId: number, messageId: number, postId: number | null) {
  return {
    userId,
    type: NotificationType.SYSTEM,
    actorIds: [] as number[],
    actorCount: 0,
    postId,
    messageId,
    content: null as string | null,
  }
}

/** 批删未读缓存（广播直接 createMany 落库，需失效缓存让下次读取走 COUNT 对账） */
async function invalidateUnreadBatch(userIds: number[]): Promise<void> {
  if (userIds.length === 0) return
  await redis.del(...userIds.map((id) => RedisKey.unreadCount(id)))
}

/** 评论内容截断，过长加省略号 */
function excerpt(content: string, length = COMMENT_EXCERPT_LENGTH): string {
  const text = content.replace(/[#>*`\]\[!()-]/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, length)}…` : text
}
