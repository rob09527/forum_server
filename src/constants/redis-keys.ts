/**
 * Redis Key 命名规范：
 * - 全部小写，单词用冒号分隔
 * - 格式：{业务域}:{资源}:{标识}
 * - 动态部分用函数生成，接受参数
 */

export const RedisKey = {
  // ── 会话 ──
  /** 用户登录会话，key 为 token，value 为 userId */
  session: (token: string) => `session:${token}` as const,

  // ── 用户缓存 ──
  /** 用户公开资料缓存 */
  userProfile: (id: number) => `user:${id}:profile` as const,
  /** 用户未读通知数 */
  userUnread: (id: number) => `user:${id}:unread` as const,

  // ── 帖子缓存 ──
  /** 帖子详情缓存 */
  postDetail: (id: number) => `post:${id}:detail` as const,
  /** 帖子浏览计数（定时回写 DB） */
  postViewCount: (id: number) => `post:${id}:view_count` as const,
  /** 帖子点赞用户集合（Set） */
  likedUsers: (postId: number) => `post:${postId}:liked_users` as const,

  // ── 列表缓存 ──
  /** 热门帖子列表 */
  hotPosts: `posts:hot` as const,
  /** 板块帖子列表 */
  boardPosts: (board: string) => `posts:board:${board}` as const,

  // ── 签到 ──
  /** 每日签到用户集合（Bitmap），key 中的 date 格式为 YYYY-MM-DD */
  checkinBitmap: (date: string) => `checkin:${date}:users` as const,
  /** 用户连续签到天数 */
  checkinStreak: (userId: number) => `checkin:${userId}:streak` as const,

  // ── 限流 ──
  /** API 限流计数 */
  rateLimit: (ip: string, endpoint: string) => `rate:${ip}:${endpoint}` as const,
} as const
