import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { redis, RedisKey } from '../../lib/redis.js'
import { DmPrivacy, UserStatus } from '../../constants/business.js'
import type { DmPrivacyType } from '../../constants/business.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { NotFoundError, ForbiddenError, ValidationError } from '../../utils/errors.js'
import { isFollowing } from '../follow/follow.service.js'
import { pushToUser } from '../realtime/sse.js'
import { AUTHOR_SELECT, toAuthorBrief, type AuthorBrief } from '../user/user-decorator.js'
import { getLimitsConfig } from '../config/config.service.js'

/**
 * 用户私信（1v1 会话化）服务。
 *
 * 数据模型：Conversation 用规范排序（userAId 恒 < userBId）保证 (userAId,userBId) 唯一，
 * 双方未读数分列 unreadCountA / unreadCountB（对应 userA / userB 视角）。
 * 会话化设计为群聊预留扩展位（将来加 ConversationParticipant 表即可，无需改 Message）。
 *
 * 设计原则：
 * - 隐私门槛（dmPrivacy）在「建立会话」与「每次发送」时都实时校验：用户可中途改为「关闭私信」，
 *   既存会话也不再接收新消息（黑名单留 phase 2）。
 * - 消息是实时关键路径：事务内写 Message + 更新 Conversation 冗余字段（预览/时间/未读），
 *   事务提交后 fire-and-forget 推 SSE + 更新 Redis 未读计数（失败只记日志，不阻塞已落库的消息）。
 * - 未读总数用 Redis 计数器（dmUnread），已读时失效缓存走 SUM 对账（对齐 notification 模式）。
 */

/**
 * 会话列表预览截断长度。
 * 这一项仍是模块常量、**没有**进 `config:limits`：它是纯展示细节（列表里显示几个字），
 * 不是运维需要调的频率/体积阈值。正文长度上限与发送频率则已收拢进 `config:limits`
 * （`dmContentMaxLength` / `dmMaxPerMinute`，见 §11.7）。
 */
const DM_PREVIEW_LENGTH = 50

/** 分页结果 */
export interface Paginated<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/** 私信消息项 */
export interface MessageItem {
  id: number
  conversationId: number
  senderId: number
  content: string
  /** 发送时间，ISO 8601 */
  createdAt: string
  /** 已读时间，ISO 8601；对方已读后回填，本人消息据此渲染「已读/未读」 */
  readAt: string | null
}

/** 会话摘要（会话列表 / 新建会话返回） */
export interface ConversationSummary {
  id: number
  /** 对方用户摘要（复用全站 AuthorBrief，含装饰） */
  otherUser: AuthorBrief
  /** 最后一条消息预览（截断），空会话为 null */
  lastMessagePreview: string | null
  /** 最后消息时间，ISO 8601；空会话为 null */
  lastMessageAt: string | null
  /** 我这一侧的未读数 */
  unreadCount: number
}

/**
 * 查询本人私信隐私开关。
 */
export async function getDmPrivacy(userId: number): Promise<DmPrivacyType> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { dmPrivacy: true },
  })
  return (user?.dmPrivacy as DmPrivacyType) ?? DmPrivacy.EVERYONE
}

/** 更新本人私信隐私开关，返回生效值 */
export async function setDmPrivacy(userId: number, privacy: DmPrivacyType): Promise<DmPrivacyType> {
  if (!Object.values(DmPrivacy).includes(privacy)) {
    throw new ValidationError('无效的私信隐私设置', ErrorCode.VALIDATION_ERROR)
  }
  await prisma.user.update({
    where: { id: userId },
    data: { dmPrivacy: privacy },
  })
  return privacy
}

/**
 * 建立或获取与某用户的 1v1 会话。
 * 首次发起时应用对方隐私门槛（everyone / followers / nobody），
 * 之后同一会话直接复用（幂等 upsert）。
 */
export async function getOrCreateConversation(
  senderId: number,
  otherUserId: number,
): Promise<ConversationSummary> {
  if (senderId === otherUserId) {
    throw new ValidationError('不能给自己发私信', ErrorCode.DM_SELF)
  }

  const other = await prisma.user.findUnique({
    where: { id: otherUserId },
    select: { ...AUTHOR_SELECT, dmPrivacy: true, status: true },
  })
  if (!other) {
    throw new NotFoundError('用户', ErrorCode.NOT_FOUND)
  }

  await enforceDmPrivacy(senderId, otherUserId, other.dmPrivacy as DmPrivacyType, other.status)

  const userAId = Math.min(senderId, otherUserId)
  const userBId = Math.max(senderId, otherUserId)

  const conversation = await prisma.conversation.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    create: { userAId, userBId },
    update: {},
  })

  return {
    id: conversation.id,
    otherUser: toAuthorBrief(other),
    lastMessagePreview: conversation.lastMessagePreview,
    lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : null,
    unreadCount: ownUnread(conversation, senderId),
  }
}

/** 分页查询会话列表（仅含至少一条消息的会话，按最后消息时间倒序） */
export async function listConversations(
  userId: number,
  page = 1,
  pageSize = 20,
): Promise<Paginated<ConversationSummary>> {
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError('页码必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('每页条数必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  const safePageSize = Math.min(50, pageSize)

  const where: Prisma.ConversationWhereInput = {
    OR: [{ userAId: userId }, { userBId: userId }],
    // 过滤空会话（仅点了「发私信」但未发消息的草稿不进入列表，也规避 NULL 排序）
    lastMessageId: { not: null },
  }

  const [total, rows] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * safePageSize,
      take: safePageSize,
    }),
  ])

  // 批量取对方用户摘要，避免 N+1
  const otherUserIds = rows.map((c) => (c.userAId === userId ? c.userBId : c.userAId))
  const users = otherUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: otherUserIds } },
        select: AUTHOR_SELECT,
      })
    : []
  const userMap = new Map(users.map((u) => [u.id, toAuthorBrief(u)]))

  const items: ConversationSummary[] = rows.map((c) => {
    const otherUserId = c.userAId === userId ? c.userBId : c.userAId
    return {
      id: c.id,
      // 对方用户已被删除时兜底占位（极少见，防御性处理），前端据此显示「用户已注销」
      otherUser: userMap.get(otherUserId) ?? deletedUserBrief(otherUserId),
      lastMessagePreview: c.lastMessagePreview,
      lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
      unreadCount: ownUnread(c, userId),
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

/**
 * 分页查询会话消息（游标分页：beforeId 之前的历史，返回升序）。
 * 校验本人是会话参与者，防止越权读取他人私信。
 */
export async function listMessages(
  userId: number,
  conversationId: number,
  beforeId?: number,
  pageSize = 30,
): Promise<MessageItem[]> {
  await requireParticipant(conversationId, userId)

  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('每页条数必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  const safePageSize = Math.min(50, pageSize)

  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      ...(beforeId !== undefined ? { id: { lt: beforeId } } : {}),
    },
    orderBy: { id: 'desc' },
    take: safePageSize,
  })
  // 倒序取最新 N 条后反转，返回升序给前端直接追加渲染
  rows.reverse()
  return rows.map(toMessageItem)
}

/**
 * 发送私信。
 * 事务内写 Message + 更新 Conversation 冗余字段（预览/时间/接收方未读 +1），
 * 事务后 fire-and-forget 推 SSE + 刷新接收方未读缓存。
 */
export async function sendMessage(
  senderId: number,
  conversationId: number,
  rawContent: string,
): Promise<MessageItem> {
  const content = rawContent?.trim() ?? ''
  if (content.length < 1) {
    throw new ValidationError('私信内容不能为空', ErrorCode.DM_CONTENT_INVALID)
  }
  const { dmContentMaxLength } = await getLimitsConfig()
  if (content.length > dmContentMaxLength) {
    throw new ValidationError(`私信最长 ${dmContentMaxLength} 字`, ErrorCode.DM_CONTENT_INVALID)
  }

  const conversation = await requireParticipant(conversationId, senderId)

  // 接收方 = 会话里的另一方；未读字段按「谁发起」定位到接收方一侧
  const recipientId = conversation.userAId === senderId ? conversation.userBId : conversation.userAId

  // 发送前实时校验接收方当前隐私门槛：用户可在会话建立后改为「关闭私信」，
  // 此时既存会话也不得再向其发送（否则关掉私信仍能收到消息，违背产品语义）。
  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { dmPrivacy: true, status: true },
  })
  if (!recipient) {
    throw new NotFoundError('用户', ErrorCode.NOT_FOUND)
  }
  await enforceDmPrivacy(senderId, recipientId, recipient.dmPrivacy as DmPrivacyType, recipient.status)

  await checkDmRateLimit(senderId)

  const now = new Date()

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { conversationId, senderId, content },
    })
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageId: created.id,
        lastMessagePreview: preview(content),
        lastMessageAt: now,
        ...(recipientId === conversation.userAId
          ? { unreadCountA: { increment: 1 } }
          : { unreadCountB: { increment: 1 } }),
      },
    })
    return created
  })

  // 实时推送 + 未读计数：非关键路径，失败不阻塞已落库的消息（对齐 createAndPush 模式）
  pushMessageAsync(conversationId, recipientId, senderId, message)

  return toMessageItem(message)
}

/** 标记某会话已读：清零本人未读计数 + 给对方发来的消息打上已读回执，返回最新未读总数 */
export async function markRead(userId: number, conversationId: number): Promise<{ unread: number }> {
  const conversation = await requireParticipant(conversationId, userId)
  const ownField = conversation.userAId === userId ? 'unreadCountA' : 'unreadCountB'
  const otherUserId = conversation.userAId === userId ? conversation.userBId : conversation.userAId
  const now = new Date()

  let newlyRead = 0
  await prisma.$transaction(async (tx) => {
    if (conversation[ownField] > 0) {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { [ownField]: 0 },
      })
    }
    // 已读回执：把对方发来、尚未读的消息打上 readAt（供对方「已读」展示）
    const res = await tx.message.updateMany({
      where: { conversationId, senderId: otherUserId, readAt: null },
      data: { readAt: now },
    })
    newlyRead = res.count
  })

  // 失效本人未读缓存，让下次读取走 SUM 对账（对齐 notification.markRead 的 redis.del）
  await redis.del(RedisKey.dmUnread(userId))
  const unread = await dmUnreadTotal(userId)

  // 有新读消息才回推「已读」回执给发送方（fire-and-forget，非关键路径）
  if (newlyRead > 0) {
    pushReadReceiptAsync(conversationId, otherUserId, now)
  }

  return { unread }
}

/** 本人未读私信总数（顶栏红点）。Redis 计数器优先，miss 时 SUM 各会话未读兜底回填 */
export async function dmUnreadTotal(userId: number): Promise<number> {
  const key = RedisKey.dmUnread(userId)
  const cached = await redis.get(key)
  if (cached !== null) {
    return Number(cached)
  }

  const rows = await prisma.conversation.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    select: { userAId: true, userBId: true, unreadCountA: true, unreadCountB: true },
  })
  const total = rows.reduce(
    (sum, c) => sum + (c.userAId === userId ? c.unreadCountA : c.unreadCountB),
    0,
  )
  await redis.set(key, total)
  return total
}

// ── 内部辅助 ──

/** 校验会话存在且本人是参与者，返回会话（越权/不存在统一 404，不泄露会话存在性） */
async function requireParticipant(conversationId: number, userId: number) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  })
  if (!conversation || (conversation.userAId !== userId && conversation.userBId !== userId)) {
    throw new NotFoundError('会话', ErrorCode.CONVERSATION_NOT_FOUND)
  }
  return conversation
}

/** 建立会话时的隐私门槛校验 */
async function enforceDmPrivacy(
  senderId: number,
  otherUserId: number,
  privacy: DmPrivacyType,
  status: string,
): Promise<void> {
  // 封禁账号无法接收私信（禁言仍可读）
  if (status === UserStatus.BANNED) {
    throw new ForbiddenError('对方账号已被封禁，无法接收私信', ErrorCode.DM_FORBIDDEN)
  }
  if (privacy === DmPrivacy.NOBODY) {
    throw new ForbiddenError('对方关闭了私信', ErrorCode.DM_FORBIDDEN)
  }
  if (privacy === DmPrivacy.FOLLOWERS) {
    const following = await isFollowing(senderId, otherUserId)
    if (!following) {
      throw new ForbiddenError('对方仅允许关注的人私信', ErrorCode.DM_FORBIDDEN)
    }
  }
}

/** 私信发送频率限制（上限取 `config:limits` 的 dmMaxPerMinute，对齐 upload.service 的 checkRateLimit） */
async function checkDmRateLimit(userId: number): Promise<void> {
  const { dmMaxPerMinute } = await getLimitsConfig()
  const key = RedisKey.dmRate(userId, formatMinute(new Date()))
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, 60)
  }
  if (count > dmMaxPerMinute) {
    throw new ForbiddenError(
      `私信发送太频繁，请稍后再试（每分钟最多 ${dmMaxPerMinute} 条）`,
      ErrorCode.DM_RATE_LIMITED,
    )
  }
}

/** fire-and-forget：推送实时消息 + 刷新接收方未读缓存 */
function pushMessageAsync(
  conversationId: number,
  recipientId: number,
  senderId: number,
  message: { id: number; conversationId: number; senderId: number; content: string; createdAt: Date; readAt: Date | null },
): void {
  ;(async () => {
    try {
      const senderRow = await prisma.user.findUnique({
        where: { id: senderId },
        select: AUTHOR_SELECT,
      })
      const unread = await bumpDmUnread(recipientId)
      pushToUser(recipientId, 'dm', {
        type: 'message',
        conversationId,
        message: toMessageItem(message),
        sender: senderRow ? toAuthorBrief(senderRow) : null,
        unreadCount: unread,
      })
    } catch (err) {
      console.error(`[dm] push failed (conversationId=${conversationId}):`, err)
    }
  })()
}

/** fire-and-forget：向对方推送「已读」回执（其发来的消息已被我方读） */
function pushReadReceiptAsync(conversationId: number, notifyUserId: number, readAt: Date): void {
  ;(async () => {
    try {
      pushToUser(notifyUserId, 'dm', {
        type: 'read',
        conversationId,
        readAt: readAt.toISOString(),
      })
    } catch (err) {
      console.error(`[dm] read receipt push failed (conversationId=${conversationId}):`, err)
    }
  })()
}

/** 接收方未读 +1（Redis 计数器；miss 时走 SUM 对账，事务已提交故 SUM 已含新消息） */
async function bumpDmUnread(userId: number): Promise<number> {
  const key = RedisKey.dmUnread(userId)
  if ((await redis.exists(key)) === 1) {
    return redis.incr(key)
  }
  return dmUnreadTotal(userId)
}

/** 消息行 → DTO（Date 转 ISO 字符串） */
function toMessageItem(m: {
  id: number
  conversationId: number
  senderId: number
  content: string
  createdAt: Date
  readAt: Date | null
}): MessageItem {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    readAt: m.readAt ? m.readAt.toISOString() : null,
  }
}

/** 会话里的「我这一侧」未读数 */
function ownUnread(
  c: { userAId: number; userBId: number; unreadCountA: number; unreadCountB: number },
  userId: number,
): number {
  return c.userAId === userId ? c.unreadCountA : c.unreadCountB
}

/** 对方用户已被删除时的兜底占位（防御性，前端据此显示「用户已注销」） */
function deletedUserBrief(id: number): AuthorBrief {
  return {
    id,
    username: '已注销用户',
    avatar: null,
    level: '',
    decorColorValue: null,
    decorColorExpireAt: null,
    decorTitleValue: null,
    decorTitleStyle: null,
    decorTitleExpireAt: null,
  }
}

/** 预览截断：压缩空白、过长加省略号 */
function preview(content: string, length = DM_PREVIEW_LENGTH): string {
  const text = content.replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, length)}…` : text
}

/** 分钟格式：YYYYMMDDHHMM，用于私信频率计数 key */
function formatMinute(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${y}${m}${d}${h}${min}`
}
