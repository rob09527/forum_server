import { prisma } from '../../lib/prisma.js'
import { PointType, NotificationType } from '../../constants/business.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from '../../utils/errors.js'
import { spendPoints, creditPoints, getBalance } from '../points/points.service.js'
import { getTipConfig } from '../config/config.service.js'
import { createAndPush } from '../notification/notification.service.js'
import type { AuthorBrief } from '../user/user-decorator.js'
import { AUTHOR_SELECT, toAuthorBrief } from '../user/user-decorator.js'

/**
 * 打赏服务（docs/积分消费体系.md 2.3）。
 *
 * 产品规则（1.5）：
 * - [R47] 不抽水，100% 到账
 * - [R48] 每人每个内容只能打赏一次（唯一约束，并发由 P2002 兜底幂等）
 * - [R49] 只能打赏帖子和评论；禁自赏
 * - [R50] 打赏收入走 creditPoints，不计累计、不升级（防小号农场核心）
 * - [R53] 打赏不可撤销、不追溯
 * - [1.5.4] 帖子打赏计入热度：heatBase + min(金额, heatCap)（读 config:tip，默认 500/500）；评论打赏不计热度
 */

/** 打赏留言最大长度 [1.5.3] */
export const TIP_MESSAGE_MAX_LENGTH = 20

/** 打赏者列表项（公开：头像/留言/金额 [1.5.3]） */
export interface TipItem {
  /** 打赏记录 ID */
  id: number
  /** 金额（鸡腿） */
  amount: number
  /** 留言，选填 */
  message: string | null
  /** 打赏时间，ISO 8601 */
  createdAt: string
  /** 打赏者摘要（含装饰，前端用户名统一渲染） */
  fromUser: AuthorBrief
}

/** 打赏者列表结果 */
export interface TipListResult {
  /** 明细（倒序） */
  items: TipItem[]
  /** 打赏人数（[R48] 一人一次，人数 = 笔数，无需去重） */
  total: number
  /** 打赏总额（鸡腿） */
  totalAmount: number
}

/**
 * 打赏帖子/评论。帖子和评论同一套，单事务。
 * 事务外取内容与作者 → 自赏/金额/留言校验 → 事务内：
 * [R48] 查重 → spendPoints(TIP_OUT) → creditPoints(TIP_IN) → 冗余列 + 热度 → 写 Tip 账本 → 返回余额。
 * 事务后 fire-and-forget 通知作者（聚合语义同 LIKE）。
 */
export async function tipTarget(input: {
  targetType: 'post' | 'comment'
  targetId: number
  fromUserId: number
  amount: number
  message?: string
}): Promise<{ balance: number }> {
  // 1. 事务外取内容与作者（供事务后发通知与自赏校验）
  const content = input.targetType === 'post'
    ? await prisma.post.findUnique({ where: { id: input.targetId }, select: { id: true, authorId: true } })
    : await prisma.comment.findUnique({ where: { id: input.targetId }, select: { id: true, authorId: true } })
  if (!content) {
    throw new NotFoundError(input.targetType === 'post' ? '帖子' : '评论', ErrorCode.NOT_FOUND)
  }

  // [R49] 禁自赏
  if (content.authorId === input.fromUserId) {
    throw new ForbiddenError('不能打赏自己的内容', ErrorCode.CANNOT_TIP_SELF)
  }

  // 2. 金额区间（config:tip）；留言长度 [1.5.3]
  const cfg = await getTipConfig()
  if (input.amount < cfg.customMin || input.amount > cfg.customMax) {
    throw new ValidationError(`打赏金额需在 ${cfg.customMin}-${cfg.customMax} 之间`, ErrorCode.TIP_AMOUNT_INVALID)
  }
  const message = input.message?.trim()
  if (message && message.length > TIP_MESSAGE_MAX_LENGTH) {
    throw new ValidationError(`打赏留言最长 ${TIP_MESSAGE_MAX_LENGTH} 字`, ErrorCode.TIP_AMOUNT_INVALID)
  }

  let balance = 0
  try {
    balance = (await prisma.$transaction(async (tx) => {
      // [R48] 幂等：每人每内容仅一次。并发重复提交由唯一约束 P2002 兜底（外层 catch）
      const existing = await tx.tip.findUnique({
        where: {
          fromUserId_targetType_targetId: {
            fromUserId: input.fromUserId,
            targetType: input.targetType,
            targetId: input.targetId,
          },
        },
      })
      if (existing) throw new ConflictError('已经打赏过了', ErrorCode.ALREADY_TIPPED)

      await spendPoints(input.fromUserId, PointType.TIP_OUT, input.amount, { refId: input.targetId }, tx)
      await creditPoints(content.authorId, PointType.TIP_IN, input.amount, {}, tx) // [R47] 100% 到账

      // 冗余列 + 热度增量（仅帖子；评论打赏不计热度 [1.5.4]）
      if (input.targetType === 'post') {
        await tx.post.update({
          where: { id: input.targetId },
          data: {
            tipCount: { increment: 1 },
            tipAmount: { increment: input.amount },
            // 线性可增量 [1.5.4]：heatBase + min(金额, heatCap)，读 config:tip
            heatScore: { increment: cfg.heatBase + Math.min(input.amount, cfg.heatCap) },
          },
        })
      } else {
        await tx.comment.update({
          where: { id: input.targetId },
          data: { tipCount: { increment: 1 }, tipAmount: { increment: input.amount } },
        })
      }

      await tx.tip.create({
        data: {
          fromUserId: input.fromUserId,
          toUserId: content.authorId,
          targetType: input.targetType,
          targetId: input.targetId,
          amount: input.amount,
          message: message ?? null,
        },
      })

      // 返回打赏者扣款后的最新余额，供前端同步顶栏 chip [3.1]
      return { balance: await getBalance(tx, input.fromUserId) }
    })).balance
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('已经打赏过了', ErrorCode.ALREADY_TIPPED)
    throw err
  }

  // 事务后 fire-and-forget 通知作者（聚合语义同 LIKE，见 createNotification 的 aggregateKey）
  createAndPush({
    userId: content.authorId,
    type: NotificationType.TIP,
    actorId: input.fromUserId,
    postId: input.targetType === 'post' ? input.targetId : null,
    commentId: input.targetType === 'comment' ? input.targetId : null,
  })

  return { balance }
}

/** 打赏者列表（GET /api/posts/:id/tips 与 /api/comments/:id/tips，公开） */
export async function listTips(targetType: 'post' | 'comment', targetId: number, limit = 50): Promise<TipListResult> {
  const safeLimit = Math.min(50, Math.max(1, limit))

  const [rows, agg] = await Promise.all([
    prisma.tip.findMany({
      where: { targetType, targetId },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
      select: { id: true, amount: true, message: true, createdAt: true, fromUserId: true },
    }),
    prisma.tip.aggregate({
      where: { targetType, targetId },
      _count: true,
      _sum: { amount: true },
    }),
  ])

  // 批量取打赏者（含装饰列，前端 UsernameText 统一渲染）
  const fromIds = [...new Set(rows.map((r) => r.fromUserId))]
  const users = fromIds.length
    ? await prisma.user.findMany({ where: { id: { in: fromIds } }, select: AUTHOR_SELECT })
    : []
  const userMap = new Map(users.map((u) => [u.id, toAuthorBrief(u)]))

  return {
    items: rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      message: r.message,
      createdAt: r.createdAt.toISOString(),
      fromUser: userMap.get(r.fromUserId) ?? {
        id: r.fromUserId,
        username: '用户已注销',
        avatar: null,
        level: '',
        decorColorValue: null,
        decorColorExpireAt: null,
        decorTitleValue: null,
        decorTitleStyle: null,
        decorTitleExpireAt: null,
      },
    })),
    total: agg._count,
    totalAmount: agg._sum.amount ?? 0,
  }
}

/** 判断是否为 Prisma 唯一约束冲突错误 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002'
}
