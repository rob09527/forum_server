import { prisma } from '../../lib/prisma.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { NotFoundError, ForbiddenError, ValidationError } from '../../utils/errors.js'
import { PointType, UserRole } from '../../constants/business.js'
import { earnPoints } from '../points/points.service.js'
import type { UserPublic } from '../auth/auth.service.js'

/** 评论创建请求 */
export interface CreateCommentInput {
  /** Markdown 格式评论内容 */
  content: string
  /** 回复目标评论 ID，null 表示顶层楼层，有值表示楼中楼回复 */
  parentId?: number | null
}

/** 评论列表项 */
export interface CommentItem {
  /** 评论 ID */
  id: number
  /** Markdown 格式评论内容 */
  content: string
  /** 所属帖子 ID */
  postId: number
  /** 回复目标评论 ID，null 表示顶层楼层 */
  parentId: number | null
  /** 楼层号（顶层评论才有，楼中楼回复为 null） */
  floor: number | null
  /** 点赞数 */
  likeCount: number
  /** 作者摘要 */
  author: {
    /** 作者 ID */
    id: number
    /** 用户名 */
    username: string
    /** 头像 URL */
    avatar: string | null
    /** 用户等级 */
    level: string
  }
  /** 评论时间，ISO 8601 */
  createdAt: string
}

/** 帖子评论树：楼层 + 楼中楼回复（递归） */
export interface CommentTreeItem extends CommentItem {
  /** 该楼层下的楼中楼回复（递归嵌套） */
  replies: CommentTreeItem[]
}

/** 分页结果 */
export interface Paginated<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/**
 * 发评论。
 * 顶层评论（parentId=null）分配楼层号，post.commentCount +1；
 * 楼中楼回复（parentId 有值）不占楼层，不增加 commentCount。
 */
export async function createComment(
  postId: number,
  input: CreateCommentInput,
  authorId: number,
): Promise<CommentItem> {
  const content = input.content?.trim() ?? ''
  if (content.length < 1) {
    throw new ValidationError('评论内容不能为空', ErrorCode.COMMENT_CONTENT_TOO_SHORT)
  }

  // 帖子必须存在
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } })
  if (!post) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }

  // 楼中楼回复：校验 parent 存在且属于同一帖子
  let floor: number | null = null
  if (input.parentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: input.parentId },
      select: { id: true, postId: true },
    })
    if (!parent) {
      throw new NotFoundError('评论', ErrorCode.COMMENT_NOT_FOUND)
    }
    if (parent.postId !== postId) {
      throw new ValidationError('回复的评论不属于该帖子', ErrorCode.COMMENT_PARENT_MISMATCH)
    }
    // 楼中楼回复不分配楼层号（floor=null），父楼层的归属靠 parentId 表达。
    // 若存 parent.floor，会与 @@unique([postId, floor]) 冲突（多回复同一楼层时唯一约束报错）
    floor = null
  } else {
    // 顶层评论：分配下一个楼层号（该帖子下最大楼层 +1）
    const last = await prisma.comment.aggregate({
      where: { postId },
      _max: { floor: true },
    })
    floor = (last._max.floor ?? 0) + 1
  }

  const comment = await prisma.comment.create({
    data: {
      content,
      postId,
      authorId,
      parentId: input.parentId ?? null,
      floor,
    },
    include: {
      author: {
        select: { id: true, username: true, avatar: true, level: true },
      },
    },
  })

  // 只有顶层评论才计入评论总数
  if (!input.parentId) {
    await Promise.all([
      prisma.post.update({
        where: { id: postId },
        data: { commentCount: { increment: 1 } },
      }),
      prisma.user.update({
        where: { id: authorId },
        data: { commentCount: { increment: 1 } },
      }),
    ])
  }

  // [R2] 评论 +3 鸡腿（含楼中楼回复），当日最多 10 条有分，超限静默跳过
  const result = await earnPoints(authorId, PointType.COMMENT, { refId: comment.id })

  const item = toItem(comment)
  // 升级即时生效：返回给前端的作者等级覆盖为升级后的值 [R22]
  if (result.earned > 0 && result.level) {
    item.author.level = result.level
  }
  return item
}

/**
 * 获取帖子评论列表。
 * 拉取帖子全部评论，构建完整递归树，再对顶层节点分页。
 * 按楼层号升序（顶层），楼中楼按创建时间升序。
 */
export async function listPostComments(
  postId: number,
  page = 1,
  pageSize = 20,
): Promise<Paginated<CommentTreeItem>> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } })
  if (!post) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }

  const skip = (Math.max(1, page) - 1) * Math.min(50, Math.max(1, pageSize))
  const take = Math.min(50, Math.max(1, pageSize))

  // 一次性拉取该帖子下所有评论（不再限制深度）
  const allComments = await prisma.comment.findMany({
    where: { postId },
    orderBy: { createdAt: 'asc' },
    include: {
      author: { select: { id: true, username: true, avatar: true, level: true } },
    },
  })

  // 构建完整递归树：id → CommentTreeItem
  const map = new Map<number, CommentTreeItem>()
  const topLevel: CommentTreeItem[] = []

  // 第一遍：所有评论转为 CommentTreeItem，放入 map
  for (const c of allComments) {
    const item: CommentTreeItem = { ...toItem(c), replies: [] }
    map.set(c.id, item)
  }

  // 第二遍：按 parentId 挂入父节点的 replies
  for (const c of allComments) {
    const item = map.get(c.id)!
    if (c.parentId !== null) {
      const parent = map.get(c.parentId)
      if (parent) {
        parent.replies.push(item)
      } else {
        // 父评论不在本帖子内（理论上不应发生），降级为顶层
        topLevel.push(item)
      }
    } else {
      topLevel.push(item)
    }
  }

  // 顶层按楼层号排序（无楼层的回复排在最后）
  topLevel.sort((a, b) => {
    if (a.floor === null && b.floor === null) return 0
    if (a.floor === null) return 1
    if (b.floor === null) return -1
    return a.floor - b.floor
  })

  const total = topLevel.length
  const items = topLevel.slice(skip, skip + take)

  return {
    items,
    page: Math.max(1, page),
    pageSize: take,
    total,
    totalPages: Math.ceil(total / take),
  }
}

/**
 * 编辑评论。
 * 仅作者本人可编辑，回复目标不可修改。
 */
export async function updateComment(
  id: number,
  content: string,
  userId: number,
): Promise<CommentItem> {
  const existing = await prisma.comment.findUnique({ where: { id } })
  if (!existing) {
    throw new NotFoundError('评论', ErrorCode.COMMENT_NOT_FOUND)
  }
  if (existing.authorId !== userId) {
    throw new ForbiddenError('只能编辑自己的评论', ErrorCode.COMMENT_NOT_OWNER)
  }

  const trimmed = content?.trim() ?? ''
  if (trimmed.length < 1) {
    throw new ValidationError('评论内容不能为空', ErrorCode.COMMENT_CONTENT_TOO_SHORT)
  }

  const comment = await prisma.comment.update({
    where: { id },
    data: { content: trimmed },
    include: {
      author: { select: { id: true, username: true, avatar: true, level: true } },
    },
  })

  return toItem(comment)
}

/**
 * 删除评论。
 * 仅作者本人或 admin。删顶层评论时级联删其楼中楼回复（含 comment_likes），
 * 并同步 post.commentCount。楼中楼回复不占用 commentCount，删除时无需调整。
 */
export async function deleteComment(id: number, user: UserPublic): Promise<void> {
  const existing = await prisma.comment.findUnique({ where: { id } })
  if (!existing) {
    throw new NotFoundError('评论', ErrorCode.COMMENT_NOT_FOUND)
  }
  if (existing.authorId !== user.id && user.role !== UserRole.ADMIN) {
    throw new ForbiddenError('只能删除自己的评论', ErrorCode.COMMENT_NOT_OWNER)
  }

  await prisma.comment.delete({ where: { id } })

  // 顶层评论被删 → 帖子评论数 -1
  if (!existing.parentId) {
    await prisma.post.update({
      where: { id: existing.postId },
      data: { commentCount: { decrement: 1 } },
    })
  }
}

/** 将 Prisma Comment（含 author）转为列表项 */
function toItem(comment: {
  id: number
  content: string
  postId: number
  parentId: number | null
  floor: number | null
  likeCount: number
  createdAt: Date
  author: { id: number; username: string; avatar: string | null; level: string }
}): CommentItem {
  return {
    id: comment.id,
    content: comment.content,
    postId: comment.postId,
    parentId: comment.parentId,
    floor: comment.floor,
    likeCount: comment.likeCount,
    author: {
      id: comment.author.id,
      username: comment.author.username,
      avatar: comment.author.avatar,
      level: comment.author.level,
    },
    createdAt: comment.createdAt.toISOString(),
  }
}
