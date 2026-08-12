import { prisma } from '../../lib/prisma.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { PointType } from '../../constants/business.js'
import { earnPoints } from '../points/points.service.js'

/**
 * 点赞服务。
 * 帖子和评论点赞共用一套逻辑：INSERT 点赞记录 + 冗余 likeCount +1。
 * 唯一约束 (postId, userId) / (commentId, userId) 保证一人只能点一次。
 */

/** 点赞帖子，返回更新后的 likeCount */
export async function likePost(postId: number, userId: number): Promise<number> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true } })
  if (!post) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }

  try {
    await prisma.postLike.create({
      data: { postId, userId },
    })
  } catch (err) {
    // 唯一约束冲突 → 已经点过赞了
    if (isUniqueViolation(err)) {
      throw new ConflictError('已经点过赞了', ErrorCode.ALREADY_LIKED)
    }
    throw err
  }

  const updated = await prisma.post.update({
    where: { id: postId },
    data: { likeCount: { increment: 1 } },
    select: { likeCount: true },
  })

  // [R3] 被点赞 +1 鸡腿给作者；重复点赞已被 UNIQUE 约束拦截走上面的冲突分支，天然幂等
  await earnPoints(post.authorId, PointType.LIKED, { refId: postId })

  return updated.likeCount
}

/** 取消点赞帖子，返回更新后的 likeCount */
export async function unlikePost(postId: number, userId: number): Promise<number> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } })
  if (!post) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }

  const result = await prisma.postLike.deleteMany({
    where: { postId, userId },
  })
  if (result.count === 0) {
    throw new ConflictError('还没点赞，无法取消', ErrorCode.NOT_LIKED)
  }

  const updated = await prisma.post.update({
    where: { id: postId },
    data: { likeCount: { decrement: 1 } },
    select: { likeCount: true },
  })
  return updated.likeCount
}

/** 点赞评论，返回更新后的 likeCount */
export async function likeComment(commentId: number, userId: number): Promise<number> {
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true, authorId: true } })
  if (!comment) {
    throw new NotFoundError('评论', ErrorCode.COMMENT_NOT_FOUND)
  }

  try {
    await prisma.commentLike.create({
      data: { commentId, userId },
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError('已经点过赞了', ErrorCode.ALREADY_LIKED)
    }
    throw err
  }

  const updated = await prisma.comment.update({
    where: { id: commentId },
    data: { likeCount: { increment: 1 } },
    select: { likeCount: true },
  })

  // [R3] 被点赞 +1 鸡腿给评论作者；重复点赞已被 UNIQUE 约束拦截，天然幂等
  await earnPoints(comment.authorId, PointType.LIKED, { refId: commentId })

  return updated.likeCount
}

/** 取消点赞评论，返回更新后的 likeCount */
export async function unlikeComment(commentId: number, userId: number): Promise<number> {
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true } })
  if (!comment) {
    throw new NotFoundError('评论', ErrorCode.COMMENT_NOT_FOUND)
  }

  const result = await prisma.commentLike.deleteMany({
    where: { commentId, userId },
  })
  if (result.count === 0) {
    throw new ConflictError('还没点赞，无法取消', ErrorCode.NOT_LIKED)
  }

  const updated = await prisma.comment.update({
    where: { id: commentId },
    data: { likeCount: { decrement: 1 } },
    select: { likeCount: true },
  })
  return updated.likeCount
}

/** 判断是否为 Prisma 唯一约束冲突错误 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002'
}
