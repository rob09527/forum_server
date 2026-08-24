import { prisma } from '../../lib/prisma.js'
import { config } from '../../config.js'
import { PointType, UserRole } from '../../constants/business.js'
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from '../../utils/errors.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { redis, RedisKey } from '../../lib/redis.js'
import { cleanPostImages, extractImagePaths } from '../upload/upload.service.js'
import { earnPoints } from '../points/points.service.js'
import { getBookmarkedIds } from '../bookmark/bookmark.service.js'
import type { UserPublic } from '../auth/auth.service.js'
import { toListItem } from './post-formatter.js'
import type { PostListItem } from './post-formatter.js'
import { indexPost, removePost } from '../search/search.service.js'
import { notifyMentions } from '../notification/notification.service.js'

// 对外保持 post.service 仍是 PostListItem 的出口（引用处无需改动）
export type { PostListItem } from './post-formatter.js'

/** 帖子创建请求 */
export interface CreatePostInput {
  /** 帖子标题，1-200 字符 */
  title: string
  /** Markdown 格式正文，至少 POST_MIN_CONTENT_LENGTH 字符 */
  content: string
  /** 所属板块，必须为已启用的分类 slug（categories 表） */
  category: string
  /** 标签列表，最多 5 个，每个最长 20 字符 */
  tags?: string[]
}

/** 帖子编辑请求，category 不可修改 */
export interface UpdatePostInput {
  /** 帖子标题，1-200 字符 */
  title?: string
  /** Markdown 格式正文，至少 POST_MIN_CONTENT_LENGTH 字符 */
  content?: string
  /** 标签列表，最多 5 个，每个最长 20 字符 */
  tags?: string[]
}

/** 帖子列表查询参数 */
export interface PostListQuery {
  /** 板块筛选，不传返回全部 */
  category?: string
  /** 标签筛选，不传不过滤 */
  tag?: string
  /** 作者筛选，不传返回全部（「我的帖子」用） */
  authorId?: number
  /** 排序：latest(最新) | hot(最热)，默认 latest */
  sort?: 'latest' | 'hot'
  /** 页码，从 1 开始 */
  page?: number
  /** 每页条数，最大 50，默认 20 */
  pageSize?: number
}

/** 帖子详情（含正文 content） */
export interface PostDetail extends PostListItem {
  /** Markdown 格式正文 */
  content: string
  /** 最后更新时间，ISO 8601（编辑后可展示"最后编辑于"） */
  updatedAt: string
}

/** 分页结果 */
export interface Paginated<T> {
  /** 当前页数据 */
  items: T[]
  /** 当前页码 */
  page: number
  /** 每页条数 */
  pageSize: number
  /** 总条数 */
  total: number
  /** 总页数 */
  totalPages: number
}

/** 首页热门帖子 Top N（侧边栏用） */
export interface HotPost {
  /** 帖子 ID */
  id: number
  /** 标题 */
  title: string
  /** 所属板块 */
  category: string
  /** 热度分 */
  heatScore: number
}

/**
 * 创建帖子。
 * 校验通过后写入 DB，作者 postCount +1。
 */
export async function createPost(input: CreatePostInput, authorId: number): Promise<PostDetail> {
  const { title, content, category, tags = [] } = input

  // 标题校验
  const trimmedTitle = title?.trim() ?? ''
  if (trimmedTitle.length < 1 || trimmedTitle.length > 200) {
    throw new ValidationError('标题需要 1-200 个字符', ErrorCode.POST_TITLE_INVALID)
  }

  // 正文长度校验（防止水帖）
  const trimmedContent = content?.trim() ?? ''
  if (trimmedContent.length < config.POST_MIN_CONTENT_LENGTH) {
    throw new ValidationError(`正文至少 ${config.POST_MIN_CONTENT_LENGTH} 个字符`, ErrorCode.POST_CONTENT_TOO_SHORT)
  }

  // 板块合法性校验（分类由 categories 表驱动，必须存在且启用）
  const categoryExists = await prisma.category.findFirst({
    where: { slug: category, isEnabled: true },
  })
  if (!categoryExists) {
    throw new ValidationError('无效的板块', ErrorCode.POST_CATEGORY_INVALID)
  }

  // 标签校验：最多 5 个，每个最长 20 字符
  const cleanTags = Array.isArray(tags)
    ? tags.map((t) => t.trim()).filter(Boolean)
    : []
  if (cleanTags.length > 5) {
    throw new ValidationError('最多 5 个标签', ErrorCode.POST_TAGS_INVALID)
  }
  if (cleanTags.some((t) => t.length > 20)) {
    throw new ValidationError('每个标签最长 20 个字符', ErrorCode.POST_TAGS_INVALID)
  }

  // 「建帖 → 发帖数 +1 → 发分」原子化，避免帖子存在但计数/积分没落库的脏数据
  const { post, result } = await prisma.$transaction(async (tx) => {
    const post = await tx.post.create({
      data: {
        title: trimmedTitle,
        content: trimmedContent,
        category,
        tags: cleanTags,
        authorId,
      },
      include: {
        author: {
          select: { id: true, username: true, avatar: true, level: true },
        },
      },
    })

    // 冗余计数：作者发帖数 +1（发帖是低频操作，直接 update）
    await tx.user.update({
      where: { id: authorId },
      data: { postCount: { increment: 1 } },
    })

    // [R1] 发帖 +10 鸡腿，当日最多 3 帖有分，超限静默跳过
    const result = await earnPoints(authorId, PointType.POST, { refId: post.id }, tx)

    return { post, result }
  })

  const detail = toDetail(post)
  // 升级即时生效：返回给前端的作者等级覆盖为升级后的值 [R22]
  if (result.earned > 0 && result.level) {
    detail.author.level = result.level
  }

  // 同步搜索索引（fire-and-forget：索引是派生数据，失败不阻塞发帖，可 reindexAll 修复）
  indexPost(post).catch((err) => {
    console.error('[search] index post failed:', err)
  })

  // @提及通知（fire-and-forget）：正文里 @ 到的人收到通知；排除作者本人
  notifyMentions({
    content: trimmedContent,
    actorId: authorId,
    postId: post.id,
  })

  return detail
}

/**
 * 查询单个帖子详情。
 * 同时异步更新浏览计数（Redis SET 去重，同一用户 24h 内只计一次）。
 * viewerId 为 null 表示未登录用户，不计数（防刷）；登录时注入 isBookmarked。
 */
export async function getPostById(id: number, viewerId?: number): Promise<PostDetail> {
  const post = await prisma.post.findUnique({
    where: { id },
    include: {
      author: {
        select: { id: true, username: true, avatar: true, level: true },
      },
    },
  })

  if (!post) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }

  // 异步浏览计数：未登录（viewerId 为 null）不计数
  if (viewerId) {
    recordViewCount(post.id, viewerId).catch((err) => {
      // 浏览计数是增强功能，失败不影响响应
      console.error('[post] view count record failed:', err)
    })
  }

  // 收藏态注入：单条查当前用户是否已收藏（仅本人可见）
  let isBookmarked = false
  if (viewerId) {
    const bm = await prisma.bookmark.findUnique({
      where: { userId_postId: { userId: viewerId, postId: post.id } },
      select: { id: true },
    })
    isBookmarked = bm !== null
  }

  const detail = toDetail(post)
  detail.isBookmarked = isBookmarked
  return detail
}

/**
 * 浏览计数（Redis 去重）。
 * SADD 返回 1 → 新用户，INCR DB viewCount；返回 0 → 已看过，忽略。
 */
async function recordViewCount(postId: number, userId: number): Promise<void> {
  const viewersKey = RedisKey.postViewers(postId)
  const added = await redis.sadd(viewersKey, String(userId))

  if (added === 1) {
    // 首次浏览，设置 TTL 后定时回写 DB
    await redis.expire(viewersKey, RedisKey.postViewerTtl)
    await prisma.post.update({
      where: { id: postId },
      data: { viewCount: { increment: 1 }, heatScore: { increment: 1 } },
    })
  }
}

/**
 * 帖子列表查询。
 * latest：置顶优先 + 发布时间倒序
 * hot：最近 7 天 + 热度分倒序
 * viewerId 为当前登录用户（可选登录接口），用于批量注入 isBookmarked；未登录为 undefined。
 */
export async function listPosts(
  query: PostListQuery,
  viewerId?: number,
): Promise<Paginated<PostListItem>> {
  // 页码/页大小校验：NaN、小数、负数直接抛校验错误（避免 skip: NaN 导致 500）
  const page = Number(query.page ?? 1)
  const pageSize = Number(query.pageSize ?? 20)
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError('页码必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('每页条数必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  const safePageSize = Math.min(50, pageSize)
  const sort = query.sort ?? 'latest'
  const category = query.category
  const tag = query.tag
  const authorId = query.authorId

  // 作者筛选：必须为正整数，非法值直接抛错（避免 where authorId: NaN 静默返回空）
  if (authorId !== undefined && (!Number.isInteger(authorId) || authorId < 1)) {
    throw new ValidationError('作者 ID 必须是正整数', ErrorCode.VALIDATION_ERROR)
  }

  const where = {
    ...(category ? { category } : {}),
    // 标签筛选：TEXT[] 数组包含该标签
    ...(tag ? { tags: { has: tag } } : {}),
    // 作者筛选：只查某位用户发布的帖子
    ...(authorId ? { authorId } : {}),
  }

  // hot：最近 7 天 + 按物化 heatScore 降序（写路径增量维护，公式 = likeCount*300 + commentCount*200 + viewCount）。
  // 索引 [createdAt, heatScore] 服务 7 天窗口的范围扫描；orderBy 首键是 isPinned，
  // 残余 isPinned+heatScore 排序为有界窗口内小集合显式排序，可接受（已消除改造前的全量拉回内存 JS 排序）。
  if (sort === 'hot') {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000)
    const hotWhere = { ...where, createdAt: { gte: sevenDaysAgo } }
    const [total, posts] = await Promise.all([
      prisma.post.count({ where: hotWhere }),
      prisma.post.findMany({
        where: hotWhere,
        include: {
          author: {
            select: { id: true, username: true, avatar: true, level: true },
          },
        },
        orderBy: [{ isPinned: 'desc' }, { heatScore: 'desc' }],
        skip: (page - 1) * safePageSize,
        take: safePageSize,
      }),
    ])

    const bookmarkedIds = viewerId ? await getBookmarkedIds(viewerId, posts.map((p) => p.id)) : new Set<number>()

    return {
      items: posts.map((p) => toListItem(p, bookmarkedIds.has(p.id))),
      page,
      pageSize: safePageSize,
      total,
      totalPages: Math.ceil(total / safePageSize),
    }
  }

  // latest：置顶优先 + 时间倒序
  const [total, posts] = await Promise.all([
    prisma.post.count({ where }),
    prisma.post.findMany({
      where,
      include: {
        author: {
          select: { id: true, username: true, avatar: true, level: true },
        },
      },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * safePageSize,
      take: safePageSize,
    }),
  ])

  const bookmarkedIds = viewerId ? await getBookmarkedIds(viewerId, posts.map((p) => p.id)) : new Set<number>()

  return {
    items: posts.map((p) => toListItem(p, bookmarkedIds.has(p.id))),
    page,
    pageSize: safePageSize,
    total,
    totalPages: Math.ceil(total / safePageSize),
  }
}

/**
 * 编辑帖子。
 * 仅作者本人可编辑，板块不可修改。
 */
export async function updatePost(id: number, input: UpdatePostInput, userId: number): Promise<PostDetail> {
  const existing = await prisma.post.findUnique({ where: { id } })
  if (!existing) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }
  if (existing.authorId !== userId) {
    throw new ForbiddenError('只能编辑自己的帖子', ErrorCode.POST_NOT_OWNER)
  }

  const data: { title?: string; content?: string; tags?: string[] } = {}

  // 标题
  if (input.title !== undefined) {
    const title = input.title.trim()
    if (title.length < 1 || title.length > 200) {
      throw new ValidationError('标题需要 1-200 个字符', ErrorCode.POST_TITLE_INVALID)
    }
    data.title = title
  }

  // 正文
  if (input.content !== undefined) {
    const content = input.content.trim()
    if (content.length < config.POST_MIN_CONTENT_LENGTH) {
      throw new ValidationError(`正文至少 ${config.POST_MIN_CONTENT_LENGTH} 个字符`, ErrorCode.POST_CONTENT_TOO_SHORT)
    }
    data.content = content
  }

  // 标签
  if (input.tags !== undefined) {
    const tags = input.tags.map((t) => t.trim()).filter(Boolean)
    if (tags.length > 5) {
      throw new ValidationError('最多 5 个标签', ErrorCode.POST_TAGS_INVALID)
    }
    if (tags.some((t) => t.length > 20)) {
      throw new ValidationError('每个标签最长 20 个字符', ErrorCode.POST_TAGS_INVALID)
    }
    data.tags = tags
  }

  const post = await prisma.post.update({
    where: { id },
    data,
    include: {
      author: {
        select: { id: true, username: true, avatar: true, level: true },
      },
    },
  })

  // 同步搜索索引（fire-and-forget，编辑后的标题/正文/标签变更立即生效于搜索）
  indexPost(post).catch((err) => {
    console.error('[search] index post failed:', err)
  })

  return toDetail(post)
}

/**
 * 执行帖子硬删除（无权限判断，权限由调用方保证）。
 * 级联删除评论/点赞，并清理 content 引用的本地图片。
 */
async function performDelete(id: number): Promise<void> {
  const existing = await prisma.post.findUnique({ where: { id } })
  if (!existing) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }

  // 提取正文中引用的本地图片路径（相对路径 /uploads/...）
  const imagePaths = extractImagePaths(existing.content)

  // 级联删除：comments 的 onDelete Cascade 会自动清子回复和 comment_likes，
  // post_likes 通过 post 的 onDelete Cascade 自动清。
  // 删除帖子 + 作者发帖数 -1 同事务，避免「删了但计数没减」。
  await prisma.$transaction(async (tx) => {
    await tx.post.delete({ where: { id } })
    await tx.user.update({
      where: { id: existing.authorId },
      data: { postCount: { decrement: 1 } },
    })
  })

  // 清理引用的本地图片（unlink 失败只记日志，不影响主流程）
  await cleanPostImages(existing.authorId, imagePaths)

  // 同步删除搜索索引（fire-and-forget）
  removePost(id).catch((err) => {
    console.error('[search] remove post failed:', err)
  })
}

/**
 * 删除帖子（硬删除）。
 * 仅作者本人或 admin 可删。
 */
export async function deletePost(id: number, user: UserPublic): Promise<void> {
  const existing = await prisma.post.findUnique({ where: { id } })
  if (!existing) {
    throw new NotFoundError('帖子', ErrorCode.POST_NOT_FOUND)
  }
  if (existing.authorId !== user.id && user.role !== UserRole.ADMIN) {
    throw new ForbiddenError('只能删除自己的帖子', ErrorCode.POST_NOT_OWNER)
  }

  await performDelete(id)
}

/**
 * 管理端删除帖子（X-Admin-Key 已鉴权，无需再判所有权）。
 * 由 Cool Admin 后端通过 /api/admin/posts/:id/delete 调用。
 */
export async function deletePostById(id: number): Promise<void> {
  await performDelete(id)
}

/** 首页热门帖子 Top N（侧边栏用，不传 category 或传全部） */
export async function getHotPosts(limit = 10): Promise<HotPost[]> {
  // 最近 7 天，按物化 heatScore 降序取前 N；索引服务 7 天窗口范围扫描，残余排序为窗口内小集合显式排序
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000)
  const posts = await prisma.post.findMany({
    where: { createdAt: { gte: sevenDaysAgo } },
    orderBy: [{ isPinned: 'desc' }, { heatScore: 'desc' }],
    take: limit,
    select: { id: true, title: true, category: true, heatScore: true },
  })

  return posts.map((p) => ({
    id: p.id,
    title: p.title,
    category: p.category,
    // 物化列存 ×100 整数，对外展示还原为与旧 heatScore() 一致的浮点值
    heatScore: p.heatScore / 100,
  }))
}

/** 将 Prisma Post（含 content + author）转为详情 */
function toDetail(post: {
  id: number
  title: string
  content: string
  category: string
  tags: string[]
  author: { id: number; username: string; avatar: string | null; level: string }
  viewCount: number
  likeCount: number
  commentCount: number
  isPinned: boolean
  createdAt: Date
  updatedAt: Date
}): PostDetail {
  return {
    ...toListItem(post),
    content: post.content,
    updatedAt: post.updatedAt.toISOString(),
  }
}
