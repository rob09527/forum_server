import { prisma } from '../../lib/prisma.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { NotFoundError, ForbiddenError, ValidationError } from '../../utils/errors.js'
import { PointType, UserRole, NotificationType, BountyStatus } from '../../constants/business.js'
import { earnPoints } from '../points/points.service.js'
import { createAndPush, notifyMentions } from '../notification/notification.service.js'
import type { UserPublic } from '../auth/auth.service.js'
import { AUTHOR_SELECT } from '../user/user-decorator.js'
import { toAuthorBrief, type AuthorRow } from '../user/user-decorator.js'
import type { AuthorBrief } from '../user/user-decorator.js'

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
  /** 打赏笔数（冗余列，打赏时同事务增量维护，读零 JOIN） */
  tipCount: number
  /** 打赏总金额（鸡腿，冗余列） */
  tipAmount: number
  /** 作者摘要（含装饰生效槽，前端内联渲染） */
  author: AuthorBrief
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

  // 帖子必须存在（顺带取 authorId/bountyStatus：发「评论了我的帖子」通知 + 悬赏新回答提醒判定）
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true, bountyStatus: true },
  })
  if (!post) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }

  // 楼中楼回复：事务前校验 parent 存在且属于同一帖子（顺带取 authorId，供发「回复了我的评论」通知）
  let parent: { id: number; postId: number; authorId: number } | null = null
  if (input.parentId) {
    parent = await prisma.comment.findUnique({
      where: { id: input.parentId },
      select: { id: true, postId: true, authorId: true },
    })
    if (!parent) {
      throw new NotFoundError('评论', ErrorCode.COMMENT_NOT_FOUND)
    }
    if (parent.postId !== postId) {
      throw new ValidationError('回复的评论不属于该帖子', ErrorCode.COMMENT_PARENT_MISMATCH)
    }
  }

  // 「发评论 → 计数/发分」原子化（顶层含楼层锁）。两分支返回同一形状 { comment, result }
  const { comment, result } = input.parentId
    ? await prisma.$transaction(async (tx) => {
        // 楼中楼回复不分配楼层号（floor=null），父楼层的归属靠 parentId 表达。
        // 若存 parent.floor，会与 @@unique([postId, floor]) 冲突（多回复同一楼层时唯一约束报错）
        const created = await tx.comment.create({
          data: { content, postId, authorId, parentId: input.parentId, floor: null },
          include: {
            author: { select: AUTHOR_SELECT },
          },
        })
        const res = await earnPoints(authorId, PointType.COMMENT, { refId: created.id }, tx)
        return { comment: created, result: res }
      })
    : await prisma.$transaction(async (tx) => {
        // 顶层评论：分配下一个楼层号（该帖子下最大楼层 +1）。
        // 事务内 FOR UPDATE 锁定帖子行，串行化同帖并发评论的楼层分配，避免撞 @@unique([postId, floor]) 落 500。
        await tx.$queryRaw`SELECT id FROM "posts" WHERE id = ${postId} FOR UPDATE`

        const last = await tx.comment.aggregate({
          where: { postId },
          _max: { floor: true },
        })
        const floor = (last._max.floor ?? 0) + 1

        const created = await tx.comment.create({
          data: { content, postId, authorId, parentId: null, floor },
          include: {
            author: { select: AUTHOR_SELECT },
          },
        })

        // 顶层评论计入评论总数：post.commentCount +1、user.commentCount +1，同事务避免脏数据；
        // 热度分 +200（heatScore = likeCount*300 + commentCount*200 + viewCount）
        await Promise.all([
          tx.post.update({
            where: { id: postId },
            data: { commentCount: { increment: 1 }, heatScore: { increment: 200 } },
          }),
          tx.user.update({
            where: { id: authorId },
            data: { commentCount: { increment: 1 } },
          }),
        ])

        const res = await earnPoints(authorId, PointType.COMMENT, { refId: created.id }, tx)
        return { comment: created, result: res }
      })

  // 通知触发（fire-and-forget，非关键路径失败不阻塞；排除自己评论/回复自己）
  if (input.parentId && parent && parent.authorId !== authorId) {
    // 楼中楼回复 → 通知被回复评论的作者
    createAndPush({
      userId: parent.authorId,
      type: NotificationType.REPLY,
      actorId: authorId,
      postId,
      commentId: parent.id,
    })
  } else if (!input.parentId && post.authorId !== authorId) {
    // 顶层评论 → 通知帖子作者
    createAndPush({
      userId: post.authorId,
      type: NotificationType.COMMENT,
      actorId: authorId,
      postId,
    })
  }

  // 悬赏新回答提醒 [2.3]：帖子处于托管中（escrow）且顶层评论者非发起人时，
  // 额外发 BOUNTY_REPLY 给发起人。仅顶层评论（才有资格成为有效回答 [1.6.2]），楼中楼不触发。
  if (!input.parentId && post.bountyStatus === BountyStatus.ESCROW && post.authorId !== authorId) {
    createAndPush({
      userId: post.authorId,
      type: NotificationType.BOUNTY_REPLY,
      actorId: authorId,
      postId,
    })
  }

  // @提及通知（fire-and-forget）：排除自己（notifyMentions 内处理）、
  // 帖子作者（已收 COMMENT）、被回复者（已收 REPLY），避免同一评论通知同一人两条
  notifyMentions({
    content,
    actorId: authorId,
    postId,
    commentId: comment.id,
    excludeIds: [post.authorId, ...(parent ? [parent.authorId] : [])],
  })

  const item = toItem(comment)
  // 升级即时生效：返回给前端的作者等级覆盖为升级后的值 [R22]
  if (result.earned > 0 && result.level) {
    item.author.level = result.level
  }
  return item
}

/**
 * 评论树逐层展开的深度上限。
 * 正常数据只有两层（顶层楼层 + 楼中楼）：导入链路显式把回复拍平到顶层评论下，
 * createComment 允许回复楼中楼、理论上能继续加深，但界面不提供更深的入口。
 * 这里留足余量并设硬上限，防脏数据（parentId 成环）把逐层展开变成死循环。
 */
const MAX_REPLY_DEPTH = 10

/**
 * 获取帖子评论列表。
 * 顶层楼层在 DB 层分页（按楼层号升序），再逐层批量取本页楼层下的楼中楼挂成树。
 * 楼中楼按创建时间升序。
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

  const safePage = Math.max(1, page)
  const take = Math.min(50, Math.max(1, pageSize))
  const skip = (safePage - 1) * take

  // 分页只作用于顶层楼层（与 post.commentCount 同口径：楼中楼不占楼层、不计数）。
  // total 用 count 实查而不是读 post.commentCount 冗余列：冗余列一旦漂移会直接错到
  // totalPages 上（末页空白或整页取不到），而单帖评论数天然有界，这次 count 走
  // (postId, createdAt) 索引、代价可忽略，且与下面的分页查询并发发出，不多一趟往返。
  const [total, topLevel] = await Promise.all([
    prisma.comment.count({ where: { postId, parentId: null } }),
    prisma.comment.findMany({
      where: { postId, parentId: null },
      // floor 升序 + NULLS LAST，等价于旧实现「无楼层的排最后」的 JS 排序语义。
      // floor 有天然空洞（deleteComment 从不重排楼层），所以只能用 skip/take 定位，
      // 不能拿 floor 当 offset 反推。同帖 floor 唯一，后两个排序键只为 null 楼层兜底稳定。
      orderBy: [{ floor: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      skip,
      take,
      include: {
        author: { select: AUTHOR_SELECT },
      },
    }),
  ])

  // 本页顶层楼层先建节点，id → 节点，供楼中楼挂载
  const map = new Map<number, CommentTreeItem>()
  const items: CommentTreeItem[] = topLevel.map((c) => {
    const item: CommentTreeItem = { ...toItem(c), replies: [] }
    map.set(c.id, item)
    return item
  })

  // 楼中楼逐层批量展开：每层只发一次 parentId in (上一层 ids)。
  // 循环里 await 是因为下一层的 ids 依赖上一层结果，查询次数 = 树深（正常两层 → 1 次），
  // 不随评论条数增长，不是按父评论逐条查的 N+1。只捞本页楼层的子孙，
  // 作者也只 include 这些行需要的，其它楼层的评论与作者完全不进内存。
  // visited 是输出契约的一部分：即使历史脏数据出现重复 parentId/环，也不得重复挂载或继续追踪。
  const visited = new Set<number>(topLevel.map((c) => c.id))
  let frontier = [...visited]
  for (let depth = 1; frontier.length > 0 && depth <= MAX_REPLY_DEPTH; depth++) {
    const replies = await prisma.comment.findMany({
      where: { postId, parentId: { in: frontier } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        author: { select: AUTHOR_SELECT },
      },
    })
    if (replies.length === 0) break

    const next: number[] = []
    for (const r of replies) {
      if (visited.has(r.id)) continue
      const parent = map.get(r.parentId!)
      // 理论不可达：parentId 取自上一层的 ids，父节点必在 map 里
      if (!parent) continue
      const item: CommentTreeItem = { ...toItem(r), replies: [] }
      parent.replies.push(item)
      map.set(r.id, item)
      visited.add(r.id)
      next.push(r.id)
    }
    frontier = next
  }

  return {
    items,
    page: safePage,
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
      author: { select: AUTHOR_SELECT },
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

  // 删除评论 + 顶层评论的帖子计数回退，同事务避免「删了但计数没减」
  await prisma.$transaction(async (tx) => {
    await tx.comment.delete({ where: { id } })

    // 顶层评论被删 → 帖子评论数 -1、热度分 -200（对齐 createComment 的 +200）
    if (!existing.parentId) {
      await tx.post.update({
        where: { id: existing.postId },
        data: { commentCount: { decrement: 1 }, heatScore: { decrement: 200 } },
      })
    }
  })
}

/** Prisma Comment 含 author 摘要的查询结果形态（create/update/findMany 均返回此形状） */
type CommentWithAuthor = {
  id: number
  content: string
  postId: number
  parentId: number | null
  floor: number | null
  likeCount: number
  tipCount: number
  tipAmount: number
  createdAt: Date
  author: AuthorRow
}

/** 将 Prisma Comment（含 author）转为列表项 */
function toItem(comment: CommentWithAuthor): CommentItem {
  return {
    id: comment.id,
    content: comment.content,
    postId: comment.postId,
    parentId: comment.parentId,
    floor: comment.floor,
    likeCount: comment.likeCount,
    tipCount: comment.tipCount,
    tipAmount: comment.tipAmount,
    author: toAuthorBrief(comment.author),
    createdAt: comment.createdAt.toISOString(),
  }
}
