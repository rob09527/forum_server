/**
 * NodeLoc（Discourse）API 响应类型。
 * 只声明导入器实际用到的字段，对方 payload 里其余几十个字段一律忽略。
 */

/** /latest.json 列表里的主题摘要 */
export interface DiscourseTopicSummary {
  /** 主题 ID */
  id: number
  /** 标题（原始文本，非 fancy_title） */
  title: string
  /** 创建时间（ISO） */
  created_at: string
  /** 最后回复时间（ISO），分页停止条件用 */
  bumped_at: string
  /** 楼层总数（含主帖），仅参考，本地 commentCount 按实际导入行数算 */
  posts_count: number
  /** 浏览数 */
  views: number
  /** 主帖点赞数 */
  like_count: number
  /** 所属分类 ID */
  category_id: number
  /** 标签(NodeLoc 配置了完整序列化,实测为对象数组;兼容标准字符串数组) */
  tags?: (string | { name: string })[]
  /** 是否有权限限制（true 表示匿名拿不到正文，跳过） */
  has_read_permission_restriction?: boolean
  /** 是否置顶 */
  pinned?: boolean
}

/** /latest.json 响应 */
export interface DiscourseLatestResponse {
  topic_list: {
    /** 本页主题列表 */
    topics: DiscourseTopicSummary[]
    /** 下一页 URL，null 表示已到末页 */
    more_topics_url?: string | null
  }
}

/** 单个楼层 */
export interface DiscoursePost {
  /** 楼层全局 ID（全站唯一，增量游标依据） */
  id: number
  /** 楼层号，1 = 主帖 */
  post_number: number
  /** 所属主题 ID */
  topic_id: number
  /** 原始 Markdown（/t/{id}.json 不含此字段，需 /raw 或 /posts.json 才有） */
  raw?: string
  /** 渲染后 HTML，用于提取 upload:// 的 sha1 → 真实 URL 映射 */
  cooked: string
  /** 发言时间（ISO） */
  created_at: string
  /** 编辑版本号，增量同步比对 */
  version: number
  /** 作者用户名 */
  username: string
  /** 作者显示名（可空） */
  name?: string | null
  /** 作者不可变数字 ID（身份锚点） */
  user_id: number
  /** 作者头像模板，含 {size} 占位 */
  avatar_template?: string
  /** 被回复的楼层号 → 本地 Comment.parentId */
  reply_to_post_number?: number | null
  /** 点赞等 reactions 汇总，只取 id=2（like）的 count（like_count 字段实测恒为 null） */
  actions_summary?: { id: number; count?: number }[]
  /** 作者自删标记（内容已抹除,导入跳过/同步时删除） */
  user_deleted?: boolean
  /** 楼层被隐藏(被举报折叠等),导入跳过 */
  hidden?: boolean
  /** 删除时间（软删标记），非 null 时同步侧按删除处理 */
  deleted_at?: string | null
  /** /posts.json 独有：所属主题标题 */
  topic_title?: string
  /** /posts.json 独有：主题类型,regular 为普通帖（private_message 等跳过） */
  topic_archetype?: string
  /** /posts.json 独有：所属分类 ID（增量同步预筛排除分类） */
  category_id?: number
}

/** /t/{id}.json 响应 */
export interface DiscourseTopicDetail {
  /** 主题 ID */
  id: number
  /** 标题 */
  title: string
  /** 创建时间 */
  created_at: string
  /** 浏览数 */
  views: number
  /** 点赞数 */
  like_count: number
  /** 分类 ID */
  category_id: number
  /** 标签(NodeLoc 配置了完整序列化,实测为对象数组;兼容标准字符串数组) */
  tags?: (string | { name: string })[]
  /** 楼层总数 */
  posts_count: number
  /** 是否置顶 */
  pinned?: boolean
  /** 是否有权限限制 */
  has_read_permission_restriction?: boolean
  post_stream: {
    /** 首批楼层（默认 20 楼） */
    posts: DiscoursePost[]
    /** 全部楼层 ID 清单，补拉剩余楼层用 */
    stream?: number[]
  }
}

/** /t/{id}/posts.json 批量补楼响应 */
export interface DiscoursePostsResponse {
  post_stream: {
    posts: DiscoursePost[]
  }
}

/** /posts.json 全站最新回复响应（增量同步核心） */
export interface DiscourseLatestPostsResponse {
  /** 最新 50 条楼层，含 raw */
  latest_posts: DiscoursePost[]
}

/** /emojis.json 中的表情项 */
export interface DiscourseEmoji {
  /** shortcode 名（不含冒号） */
  name: string
  /** 图片相对 URL */
  url: string
  /** 所属分组，自定义表情为 ac / simsimi */
  group?: string
}

/** 分类树节点（site.json / categories.json） */
export interface DiscourseCategory {
  /** 分类 ID */
  id: number
  /** 分类名 */
  name: string
  /** 父分类 ID，null 表示顶级 */
  parent_category_id?: number | null
  /** 主题数 */
  topic_count?: number
}
