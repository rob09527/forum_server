import { prisma } from '../../lib/prisma.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { NotFoundError, ConflictError, ValidationError } from '../../utils/errors.js'
import { toListItem } from '../post/post-formatter.js'
import type { PostListItem } from '../post/post-formatter.js'
import { AUTHOR_SELECT } from '../user/user-decorator.js'

/**
 * 帖子收藏服务。
 * 收藏是私密行为：仅本人可见，不对外展示收藏数、不影响热榜排序。
 * 幂等：唯一约束 (userId, postId) 保证一人一帖一条；重复收藏抛冲突，
 * 取消收藏是物理删除（无计数联动，不涉及防刷分）。
 */

/** 收藏列表项（帖子摘要 + 收藏时间） */
export interface BookmarkItem {
  /** 收藏时间，ISO 8601 */
  bookmarkedAt: string
  /** 帖子摘要（与帖子列表同一结构） */
  post: PostListItem
}

/** 分页结果 */
export interface Paginated<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/** 收藏帖子，返回最新收藏记录 ID */
export async function bookmarkPost(postId: number, userId: number): Promise<{ id: number }> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } })
  if (!post) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }

  try {
    const bookmark = await prisma.bookmark.create({ data: { postId, userId } })
    return { id: bookmark.id }
  } catch (err) {
    // 并发下重复收藏 → 唯一约束 P2002 兜底（对齐 like.service 的 isUniqueViolation 写法）
    if (isUniqueViolation(err)) {
      throw new ConflictError('已经收藏过了', ErrorCode.ALREADY_BOOKMARKED)
    }
    throw err
  }
}

/** 取消收藏（物理删除，幂等）。未收藏时抛冲突。 */
export async function unbookmarkPost(postId: number, userId: number): Promise<void> {
  const result = await prisma.bookmark.deleteMany({ where: { postId, userId } })
  if (result.count === 0) {
    throw new ConflictError('还没收藏，无法取消', ErrorCode.NOT_BOOKMARKED)
  }
}

/**
 * 分页查询用户收藏（按收藏时间倒序）。
 * 帖子被删时收藏记录级联删除，故列表中的帖子必然存在。
 */
export async function listBookmarks(
  userId: number,
  page = 1,
  pageSize = 20,
): Promise<Paginated<BookmarkItem>> {
  // 页码/页大小校验：非法值抛校验错误（避免 skip: NaN 导致 500）
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError('页码必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('每页条数必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  const safePageSize = Math.min(50, pageSize)

  const [total, rows] = await Promise.all([
    prisma.bookmark.count({ where: { userId } }),
    prisma.bookmark.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * safePageSize,
      take: safePageSize,
      include: {
        post: {
          include: {
            author: { select: AUTHOR_SELECT },
          },
        },
      },
    }),
  ])

  return {
    items: rows.map((r) => ({
      bookmarkedAt: r.createdAt.toISOString(),
      // 收藏列表里的帖子必然已收藏，isBookmarked 固定 true（取消收藏后从列表移除）
      post: toListItem(r.post, true),
    })),
    page,
    pageSize: safePageSize,
    total,
    totalPages: Math.ceil(total / safePageSize),
  }
}

/**
 * 批量查询「当前用户已收藏的帖子 ID 集合」。
 * 供帖子列表/详情注入 isBookmarked（避免 N+1）。
 */
export async function getBookmarkedIds(userId: number, postIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(postIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return new Set()

  const rows = await prisma.bookmark.findMany({
    where: { userId, postId: { in: ids } },
    select: { postId: true },
  })
  return new Set(rows.map((r) => r.postId))
}

/** 判断是否为 Prisma 唯一约束冲突错误 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002'
}
