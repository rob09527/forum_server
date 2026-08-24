import { prisma } from '../../lib/prisma.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { ConflictError, NotFoundError } from '../../utils/errors.js'
import { PointType, NotificationType } from '../../constants/business.js'
import { earnPoints } from '../points/points.service.js'
import { createAndPush } from '../notification/notification.service.js'

/**
 * 点赞服务。
 * 帖子和评论点赞共用一套逻辑：INSERT 点赞记录（active=true）+ 冗余 likeCount +1。
 * 唯一约束 (postId, userId) / (commentId, userId) 保证一人只有一条记录。
 *
 * 防刷分设计：取消点赞是「软删除」——把记录置 active=false 而非物理删除，
 * 这样重新点赞时只是恢复 active，不再重复发分（否则赞→取消→赞可无限给作者刷分）。
 *
 * 一致性：点赞记录写入 + likeCount 计数 + 发分在同一次事务内完成，
 * 避免「记录有了但计数没加」或「计数加了但分没发」的脏数据。
 */

/** 点赞帖子，返回更新后的 likeCount */
export async function likePost(postId: number, userId: number): Promise<number> {
  // 事务前取作者（供事务提交后发「被点赞」通知），post 存在性由事务内唯一约束/更新兜底，但仍先查一次避免无谓写入
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true },
  })
  if (!post) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }

  let likeCount: number
  try {
    likeCount = await prisma.$transaction(async (tx) => {
      // 先查已有记录，决定「首赞」还是「取消后重赞」；并发竞态由唯一约束 P2002 兜底（外层 catch）
      const existing = await tx.postLike.findUnique({
        where: { postId_userId: { postId, userId } },
      })
      if (existing?.active) {
        throw new ConflictError('已经点过赞了', ErrorCode.ALREADY_LIKED)
      }

      if (existing) {
        // 取消后重赞：仅当仍是 active=false 时才恢复（并发下可能已被他人重赞，此时 count=0）
        const res = await tx.postLike.updateMany({
          where: { postId, userId, active: false },
          data: { active: true },
        })
        if (res.count === 0) {
          throw new ConflictError('已经点过赞了', ErrorCode.ALREADY_LIKED)
        }
      } else {
        // 首次点赞：INSERT 记录（active 默认 true）
        await tx.postLike.create({ data: { postId, userId } })
      }

      const updated = await tx.post.update({
        where: { id: postId },
        data: { likeCount: { increment: 1 }, heatScore: { increment: 300 } },
        select: { likeCount: true },
      })

      // [R3] 被点赞 +1 鸡腿给作者；只在首次点赞发分，重赞不发分
      if (!existing) {
        await earnPoints(post.authorId, PointType.LIKED, { refId: postId }, tx)
      }

      return updated.likeCount
    })
  } catch (err) {
    // 并发下 findUnique 后、create 前被他人插入 → 唯一约束 P2002，事务回滚后在这里兜底
    if (isUniqueViolation(err)) {
      throw new ConflictError('已经点过赞了', ErrorCode.ALREADY_LIKED)
    }
    throw err
  }

  // 通知帖子作者（fire-and-forget；排除自赞）
  if (post.authorId !== userId) {
    createAndPush({
      userId: post.authorId,
      type: NotificationType.LIKE,
      actorId: userId,
      postId,
    })
  }

  return likeCount
}

/** 取消点赞帖子，返回更新后的 likeCount */
export async function unlikePost(postId: number, userId: number): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const post = await tx.post.findUnique({ where: { id: postId }, select: { id: true } })
    if (!post) {
      throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
    }

    // 软删除：置 active=false 保留记录（防重赞刷分），而非物理删除
    const result = await tx.postLike.updateMany({
      where: { postId, userId, active: true },
      data: { active: false },
    })
    if (result.count === 0) {
      throw new ConflictError('还没点赞，无法取消', ErrorCode.NOT_LIKED)
    }

    const updated = await tx.post.update({
      where: { id: postId },
      data: { likeCount: { decrement: 1 }, heatScore: { decrement: 300 } },
      select: { likeCount: true },
    })
    return updated.likeCount
  })
}

/** 点赞评论，返回更新后的 likeCount */
export async function likeComment(commentId: number, userId: number): Promise<number> {
  // 事务前取作者（供事务提交后发「被点赞」通知）
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, authorId: true },
  })
  if (!comment) {
    throw new NotFoundError('评论', ErrorCode.COMMENT_NOT_FOUND)
  }

  let likeCount: number
  try {
    likeCount = await prisma.$transaction(async (tx) => {
      const existing = await tx.commentLike.findUnique({
        where: { commentId_userId: { commentId, userId } },
      })
      if (existing?.active) {
        throw new ConflictError('已经点过赞了', ErrorCode.ALREADY_LIKED)
      }

      if (existing) {
        const res = await tx.commentLike.updateMany({
          where: { commentId, userId, active: false },
          data: { active: true },
        })
        if (res.count === 0) {
          throw new ConflictError('已经点过赞了', ErrorCode.ALREADY_LIKED)
        }
      } else {
        await tx.commentLike.create({ data: { commentId, userId } })
      }

      const updated = await tx.comment.update({
        where: { id: commentId },
        data: { likeCount: { increment: 1 } },
        select: { likeCount: true },
      })

      // [R3] 被点赞 +1 鸡腿给评论作者；只在首次点赞发分
      if (!existing) {
        await earnPoints(comment.authorId, PointType.LIKED, { refId: commentId }, tx)
      }

      return updated.likeCount
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError('已经点过赞了', ErrorCode.ALREADY_LIKED)
    }
    throw err
  }

  // 通知评论作者（fire-and-forget；排除自赞）
  if (comment.authorId !== userId) {
    createAndPush({
      userId: comment.authorId,
      type: NotificationType.LIKE,
      actorId: userId,
      commentId,
    })
  }

  return likeCount
}

/** 取消点赞评论，返回更新后的 likeCount */
export async function unlikeComment(commentId: number, userId: number): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const comment = await tx.comment.findUnique({ where: { id: commentId }, select: { id: true } })
    if (!comment) {
      throw new NotFoundError('评论', ErrorCode.COMMENT_NOT_FOUND)
    }

    const result = await tx.commentLike.updateMany({
      where: { commentId, userId, active: true },
      data: { active: false },
    })
    if (result.count === 0) {
      throw new ConflictError('还没点赞，无法取消', ErrorCode.NOT_LIKED)
    }

    const updated = await tx.comment.update({
      where: { id: commentId },
      data: { likeCount: { decrement: 1 } },
      select: { likeCount: true },
    })
    return updated.likeCount
  })
}

/** 判断是否为 Prisma 唯一约束冲突错误 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002'
}
