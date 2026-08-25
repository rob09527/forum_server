import { prisma } from '../../lib/prisma.js'
import { PointType, NotificationType, BountyStatus, BountySettleType } from '../../constants/business.js'
import { ErrorCode } from '../../constants/error-codes.js'
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from '../../utils/errors.js'
import { spendPoints, creditPoints, getBalance } from '../points/points.service.js'
import { getBountyConfig } from '../config/config.service.js'
import type { BountyConfig } from '../config/config.service.js'
import { createAndPush } from '../notification/notification.service.js'

/**
 * 悬赏问答服务（docs/积分消费体系.md 2.4）。
 *
 * 状态机（代码视角）：所有流转都是条件更新 `updateMany({ where: { id, status: 'escrow' } })`，
 * count === 0 即已结算，天然幂等（并发采纳只成功一次）。
 *
 *   escrow ──acceptAnswer──────────► settled   settleType=accept
 *     ├──createPost 发起时建
 *     ├──sweep 有有效回答 ─────────► settled   settleType=auto
 *     ├──sweep 零有效回答 ─────────► refunded  settleType=auto
 *     └──cancel 仅无有效回答 ──────► refunded  settleType=cancel
 *
 * 「有效回答」统一定义：顶层评论（floor 非空）且作者 ≠ 发起人 [1.6.2]。
 * 手续费销毁（不写任何用户流水，只记 Bounty.fee），退款不抽水 [1.6.2]。
 */

/** 采纳结果 */
export interface AcceptResult {
  /** 实发给被采纳者的金额（amount − fee） */
  payout: number
}

/**
 * 发起人采纳（POST /api/bounties/:id/accept）。
 * 单事务：校验归属/状态/采纳对象 → 条件更新 escrow→settled → 写回帖子冗余列 → creditPoints(BOUNTY_IN)。
 * 事务后通知双方（发起人「已采纳」+ 被采纳者「获得 N🍗」）[1.6.5]。
 */
export async function acceptAnswer(bountyId: number, commentId: number, userId: number): Promise<AcceptResult> {
  const cfg = await getBountyConfig() // 费用率配置 [2.6]
  const outcome = await prisma.$transaction(async (tx) => {
    const bounty = await tx.bounty.findUnique({ where: { id: bountyId } })
    if (!bounty) throw new NotFoundError('悬赏', ErrorCode.NOT_FOUND)
    if (bounty.userId !== userId) throw new ForbiddenError('仅发起人可采纳')
    if (bounty.status !== BountyStatus.ESCROW) throw new ConflictError('悬赏已结算', ErrorCode.BOUNTY_ALREADY_SETTLED)

    // 采纳目标必须是该帖的有效回答（顶层 且 非发起人自答）[1.6.6]
    const comment = await tx.comment.findFirst({
      where: { id: commentId, postId: bounty.postId, floor: { not: null }, authorId: { not: userId } },
    })
    if (!comment) throw new ValidationError('采纳对象必须是该帖的有效回答', ErrorCode.BOUNTY_ACCEPT_INVALID)

    // 分账：先算 fee，payout = amount − fee，恒有 payout + fee === amount（与 settleBounty 同算法）
    const fee = Math.round(bounty.amount * cfg.feeRate)
    const payout = bounty.amount - fee
    // 条件更新：并发采纳只有一个能成功 [T3]
    const done = await tx.bounty.updateMany({
      where: { id: bountyId, status: BountyStatus.ESCROW },
      data: {
        status: BountyStatus.SETTLED,
        acceptedCommentId: commentId,
        acceptedUserId: comment.authorId,
        payout,
        fee,
        settleType: BountySettleType.ACCEPT,
        settledAt: new Date(),
      },
    })
    if (done.count === 0) throw new ConflictError('悬赏已结算', ErrorCode.BOUNTY_ALREADY_SETTLED)

    // 同事务写回帖子冗余列，悬赏筛选 tab 才不再显示"待解决" [3.5]
    await tx.post.update({ where: { id: bounty.postId }, data: { bountyStatus: BountyStatus.SETTLED } })

    await creditPoints(comment.authorId, PointType.BOUNTY_IN, payout, { refId: bounty.postId }, tx)
    return { bounty, comment, payout }
  })

  // 事务后 fire-and-forget 通知双方 [1.6.5]
  createAndPush({
    userId: outcome.bounty.userId,
    type: NotificationType.BOUNTY_SETTLED,
    postId: outcome.bounty.postId,
    content: '你已采纳答案，悬赏已结算',
  })
  createAndPush({
    userId: outcome.comment.authorId,
    type: NotificationType.BOUNTY_SETTLED,
    postId: outcome.bounty.postId,
    content: `你的回答被采纳，获得 ${outcome.payout} 🍗`,
  })

  return { payout: outcome.payout }
}

/**
 * 发起人取消（POST /api/bounties/:id/cancel）。
 * 归属校验后走 settleBounty(cancel)：有有效回答 → 409（不能"取消改判发钱"）；
 * 无有效回答 → 条件更新幂等退款（全额退给发起人，不抽水），返回退款后余额。
 */
export async function cancelBounty(bountyId: number, userId: number): Promise<{ balance: number }> {
  const bounty = await prisma.bounty.findUnique({ where: { id: bountyId } })
  if (!bounty) throw new NotFoundError('悬赏', ErrorCode.NOT_FOUND)
  if (bounty.userId !== userId) throw new ForbiddenError('仅发起人可取消')
  // 已结算/已退款：显式 409（与 acceptAnswer 同口径），避免「已结算仍返回成功余额」的假成功
  if (bounty.status !== BountyStatus.ESCROW) {
    throw new ConflictError('悬赏已结算', ErrorCode.BOUNTY_ALREADY_SETTLED)
  }

  await settleBounty(bountyId, { settleType: BountySettleType.CANCEL })
  return { balance: await getBalance(prisma, userId) }
}

/**
 * 后台人工退款（POST /api/admin/bounties/:id/refund，X-Admin-Key 已鉴权）。
 * forceRefund=true 跳过「是否有有效回答」判定，无条件退款（处置异常 [2.4]）。
 * operator 记录操作者用户名（审计追责）。
 */
export async function adminRefundBounty(bountyId: number, operator?: string): Promise<void> {
  await settleBounty(bountyId, { settleType: BountySettleType.ADMIN, forceRefund: true, operator })
}

/**
 * 核心结算函数（人工采纳、超时自动、发起人取消、后台人工退款共用，保证所有路径幂等语义一致）：
 * 有有效回答 → 判给最高赞（同赞取最早）；否则全额退款（不抽水）[1.6.3][T7]。
 * forceRefund=true（后台人工退款）跳过"是否有有效回答"判定，无条件退款。
 */
export async function settleBounty(
  bountyId: number,
  opts: {
    settleType: 'auto' | 'cancel' | 'admin'
    forceRefund?: boolean
    operator?: string
  },
): Promise<void> {
  const { settleType, forceRefund = false, operator } = opts
  const cfg = await getBountyConfig() // 费用率配置 [2.6]

  const outcome = await prisma.$transaction(async (tx) => {
    const bounty = await tx.bounty.findUnique({ where: { id: bountyId } })
    if (!bounty || bounty.status !== BountyStatus.ESCROW) return null // 幂等：已结算直接返回
    const now = new Date()

    // 有效回答 = 顶层评论 且 作者 ≠ 发起人 [T7]（自答不算）；后台人工退款（forceRefund）跳过此判定
    const candidates = forceRefund ? [] : await tx.comment.findMany({
      where: { postId: bounty.postId, floor: { not: null }, authorId: { not: bounty.userId } },
      orderBy: [{ likeCount: 'desc' }, { id: 'asc' }], // 最高赞，同赞取最早
      take: 1,
    })
    const winner = candidates[0]

    // 取消语义 [1.6.2]：有有效回答 → 不允许取消，直接拒绝（不能"取消改判发钱"）
    if (settleType === BountySettleType.CANCEL && winner) {
      throw new ConflictError('已有有效回答，无法取消悬赏', ErrorCode.BOUNTY_ALREADY_SETTLED)
    }

    // 分账：先算 fee，payout = amount − fee，恒有 payout + fee === amount（与 acceptAnswer 同算法，审计 B2）
    const fee = winner ? Math.round(bounty.amount * cfg.feeRate) : 0
    const payout = winner ? bounty.amount - fee : 0

    const done = await tx.bounty.updateMany({
      where: { id: bountyId, status: BountyStatus.ESCROW },
      data: winner
        ? {
            status: BountyStatus.SETTLED,
            acceptedCommentId: winner.id,
            acceptedUserId: winner.authorId,
            payout,
            fee,
            settleType,
            settledAt: now,
            operator,
          }
        : { status: BountyStatus.REFUNDED, settleType, settledAt: now, operator }, // 退款：fee/payout 留 0
    })
    if (done.count === 0) return null

    // 同事务写回帖子冗余列，否则悬赏筛选 tab 永远显示"待解决" [3.5]
    await tx.post.update({
      where: { id: bounty.postId },
      data: { bountyStatus: winner ? BountyStatus.SETTLED : BountyStatus.REFUNDED },
    })

    if (winner) {
      await creditPoints(winner.authorId, PointType.BOUNTY_IN, payout, { refId: bounty.postId }, tx)
    } else {
      await creditPoints(bounty.userId, PointType.BOUNTY_REFUND, bounty.amount, { refId: bounty.postId }, tx)
    }
    return { bounty, winner, payout, settleType }
  })

  if (!outcome) return
  const { bounty, winner, payout } = outcome

  // 事务后 fire-and-forget 通知 [1.6.5]：判给 → 双方；退款 → 仅发起人
  if (winner) {
    createAndPush({
      userId: bounty.userId,
      type: NotificationType.BOUNTY_SETTLED,
      postId: bounty.postId,
      content: settleType === BountySettleType.AUTO
        ? '你的悬赏超时自动判给最高赞回答，已结算'
        : '你的悬赏已结算',
    })
    createAndPush({
      userId: winner.authorId,
      type: NotificationType.BOUNTY_SETTLED,
      postId: bounty.postId,
      content: `你的回答被采纳，获得 ${payout} 🍗`,
    })
  } else {
    const content = settleType === BountySettleType.CANCEL
      ? '你的悬赏已取消并全额退款'
      : settleType === BountySettleType.ADMIN
        ? '你的悬赏已被后台处置并全额退款'
        : '你的悬赏超时无有效回答，已全额退款'
    createAndPush({
      userId: bounty.userId,
      type: NotificationType.BOUNTY_REFUNDED,
      postId: bounty.postId,
      content,
    })
  }
}

/** 悬赏服务内部使用的配置类型引用（供外部调用方了解 feeRate 语义） */
export type { BountyConfig }
