import { prisma } from '../../lib/prisma.js'
import { meili, POSTS_INDEX } from '../../lib/meilisearch.js'
import { ValidationError } from '../../utils/errors.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { toListItem } from '../post/post-formatter.js'
import type { PostListItem } from '../post/post-formatter.js'
import type { Paginated } from '../post/post.service.js'
import { AUTHOR_SELECT } from '../user/user-decorator.js'

/** 搜索查询参数 */
export interface SearchQuery {
  /** 板块筛选，不传不过滤 */
  category?: string
  /** 页码，从 1 开始 */
  page?: number
  /** 每页条数，最大 50，默认 20 */
  pageSize?: number
}

/** 可索引的帖子字段（Prisma Post 结构子集，createPost/updatePost/reindexAll 共用） */
interface IndexablePost {
  id: number
  title: string
  content: string
  category: string
  tags: string[]
  authorId: number
  createdAt: Date
}

/**
 * 轻量 Markdown 剥离，只用于搜索索引。
 * 去掉代码块/链接/图片/标题/强调/HTML 标签等语法，只留纯文本供 Meili 分词排序。
 */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // 代码块
    .replace(/`([^`]+)`/g, '$1') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接，保留链接文字
    .replace(/<[^>]+>/g, ' ') // HTML 标签
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题 #
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 加粗
    .replace(/\*([^*]+)\*/g, '$1') // 斜体
    .replace(/~~([^~]+)~~/g, '$1') // 删除线
    .replace(/^>\s?/gm, '') // 引用
    .replace(/[-*_]\s+/g, ' ') // 列表符
    .replace(/\s+/g, ' ') // 空白折叠
    .trim()
}

/** 帖子 → Meili 文档（只写真正用到的字段：title/content 可搜，category/tags/authorId 可筛，createdAt 可排序） */
function toSearchDoc(post: IndexablePost) {
  return {
    id: post.id,
    title: post.title,
    content: stripMarkdown(post.content),
    category: post.category,
    tags: post.tags,
    authorId: post.authorId,
    createdAt: post.createdAt.getTime(),
  }
}

/**
 * 写入/更新帖子搜索文档（发帖、编辑后调用）。
 * 索引是派生数据，由调用方 fire-and-forget 异步执行，失败不阻塞主流程。
 */
export async function indexPost(post: IndexablePost): Promise<void> {
  await meili.index(POSTS_INDEX).addDocuments([toSearchDoc(post)])
}

/** 删除帖子搜索文档（删帖后调用） */
export async function removePost(id: number): Promise<void> {
  await meili.index(POSTS_INDEX).deleteDocument(id)
}

/**
 * 全文搜索帖子。
 * Meili 负责召回与排序，命中后回 PG 水合出完整 PostListItem（作者信息以 PG 为准），
 * 与 /api/posts 列表返回同一结构。
 */
export async function searchPosts(
  q: string,
  query: SearchQuery = {},
): Promise<Paginated<PostListItem>> {
  // 页码/页大小校验：NaN、小数、负数直接抛校验错误（与 listPosts 同一约定）
  const page = Number(query.page ?? 1)
  const pageSize = Number(query.pageSize ?? 20)
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError('页码必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('每页条数必须是正整数', ErrorCode.VALIDATION_ERROR)
  }
  const safePageSize = Math.min(50, pageSize)

  const keyword = q.trim()
  if (!keyword) {
    throw new ValidationError('搜索关键词不能为空', ErrorCode.VALIDATION_ERROR)
  }

  // category 来自用户 query，拼进 Meili filter 字符串前必须转义引号/反斜杠，
  // 否则 `category="x" OR ...` 这类输入会逃逸字符串字面量、篡改过滤条件。
  const filter = query.category
    ? `category = "${query.category.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : undefined

  const result = await meili.index(POSTS_INDEX).search(keyword, {
    filter,
    page,
    hitsPerPage: safePageSize,
  })

  // 命中 ID → 按 Meili 顺序回 PG 水合（findMany 的 IN 不保证顺序）
  const ids = result.hits.map((h) => h.id as number)
  const posts = ids.length
    ? await prisma.post.findMany({
        where: { id: { in: ids } },
        include: {
          author: {
            select: AUTHOR_SELECT,
          },
        },
      })
    : []
  const byId = new Map(posts.map((p) => [p.id, p]))
  const items = ids
    .map((id) => {
      const post = byId.get(id)
      return post ? toListItem(post) : undefined
    })
    .filter((x): x is PostListItem => x !== undefined)

  return {
    items,
    page,
    pageSize: safePageSize,
    total: result.totalHits,
    totalPages: result.totalPages,
  }
}

/**
 * 全量回填/修复帖子索引（存量数据 + 索引重建用）。
 * 返回本次写入的帖子总数。
 */
export async function reindexAll(): Promise<number> {
  const posts = await prisma.post.findMany({ orderBy: { id: 'asc' } })

  // 分批写入，避免单次提交文档过多
  const BATCH_SIZE = 200
  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE)
    await meili.index(POSTS_INDEX).addDocuments(batch.map((p) => toSearchDoc(p)))
  }

  return posts.length
}
