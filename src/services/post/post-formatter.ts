import { toAuthorBrief, type AuthorRow } from '../user/user-decorator.js'
import type { AuthorBrief } from '../user/user-decorator.js'

/** 帖子列表项（不含正文 content） */
export interface PostListItem {
  /** 帖子 ID */
  id: number
  /** 标题 */
  title: string
  /** 所属板块 */
  category: string
  /** 标签列表 */
  tags: string[]
  /** 作者摘要（含装饰生效槽，前端内联渲染） */
  author: AuthorBrief
  /** 浏览量 */
  viewCount: number
  /** 点赞数 */
  likeCount: number
  /** 评论数 */
  commentCount: number
  /** 打赏笔数（冗余列，打赏时同事务增量维护，读零 JOIN） */
  tipCount: number
  /** 打赏总金额（鸡腿，冗余列） */
  tipAmount: number
  /** 悬赏金额（鸡腿），非悬赏帖为 null（冗余列，列表徽章渲染 [1.6.6]） */
  bountyAmount: number | null
  /** 悬赏状态：escrow | settled | refunded，非悬赏帖为 null（冗余列，悬赏筛选 tab） */
  bountyStatus: string | null
  /** 是否置顶 */
  isPinned: boolean
  /** 当前登录用户是否已收藏（未登录或未注入时为 false；收藏为私密仅本人可见） */
  isBookmarked: boolean
  /** 最后回复用户，MVP 无评论系统前为 null */
  lastReplyUser: string | null
  /** 最后回复时间，MVP 无评论系统前为 null */
  lastReplyTime: string | null
  /** 发布时间，ISO 8601 */
  createdAt: string
}

/**
 * 将 Prisma Post（含 author）转为列表项。
 * post.service 与 search.service 共用，保证列表/搜索返回同一结构。
 * isBookmarked 为当前登录用户的收藏态，由调用方批量注入（默认 false）。
 */
export function toListItem(
  post: {
    id: number
    title: string
    category: string
    tags: string[]
    author: AuthorRow
    viewCount: number
    likeCount: number
    commentCount: number
    tipCount: number
    tipAmount: number
    bountyAmount: number | null
    bountyStatus: string | null
    isPinned: boolean
    createdAt: Date
    updatedAt: Date
  },
  isBookmarked = false,
): PostListItem {
  return {
    id: post.id,
    title: post.title,
    category: post.category,
    tags: post.tags,
    author: toAuthorBrief(post.author),
    viewCount: post.viewCount,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    tipCount: post.tipCount,
    tipAmount: post.tipAmount,
    bountyAmount: post.bountyAmount,
    bountyStatus: post.bountyStatus,
    isPinned: post.isPinned,
    isBookmarked,
    lastReplyUser: null,
    lastReplyTime: null,
    createdAt: post.createdAt.toISOString(),
  }
}
