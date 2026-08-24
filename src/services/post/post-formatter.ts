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
  /** 作者摘要 */
  author: {
    /** 作者 ID */
    id: number
    /** 用户名 */
    username: string
    /** 头像 URL，null 时前端用默认头像 */
    avatar: string | null
    /** 用户等级：claw | leg | meat */
    level: string
  }
  /** 浏览量 */
  viewCount: number
  /** 点赞数 */
  likeCount: number
  /** 评论数 */
  commentCount: number
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
    author: { id: number; username: string; avatar: string | null; level: string }
    viewCount: number
    likeCount: number
    commentCount: number
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
    author: {
      id: post.author.id,
      username: post.author.username,
      avatar: post.author.avatar,
      level: post.author.level,
    },
    viewCount: post.viewCount,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    isPinned: post.isPinned,
    isBookmarked,
    lastReplyUser: null,
    lastReplyTime: null,
    createdAt: post.createdAt.toISOString(),
  }
}
