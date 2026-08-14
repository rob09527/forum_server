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
  /** 用户的全部 session token 集合（SET），key 为 userId，用于封禁时批量下线 */
  userSessions: (userId: number) => `user:${userId}:sessions` as const,

  // ── 用户缓存 ──
  /** 用户公开资料缓存 */
  userProfile: (id: number) => `user:${id}:profile` as const,

  // ── 帖子缓存 ──
  /** 帖子详情缓存 */
  postDetail: (id: number) => `post:${id}:detail` as const,
  /** 帖子浏览计数（定时回写 DB） */
  postViewCount: (id: number) => `post:${id}:view_count` as const,
  /** 帖子点赞用户集合（Set） */
  likedUsers: (postId: number) => `post:${postId}:liked_users` as const,
  /** 已浏览帖子的用户集合（Set），用于 24h 内浏览去重，key 中的 userId 为 0 表示未登录 */
  postViewers: (postId: number) => `post:${postId}:viewers` as const,
  /** 帖子浏览去重的 TTL，单位秒（24 小时） */
  postViewerTtl: 86400,

  // ── 列表缓存 ──
  /** 热门帖子列表 */
  hotPosts: `posts:hot` as const,
  /** 板块帖子列表 */
  boardPosts: (board: string) => `posts:board:${board}` as const,

  // ── 上传限流 ──
  /** 用户每分钟上传次数计数，key 中的 minute 格式为 YYYYMMDDHHMM */
  uploadRate: (userId: number, minute: string) => `upload_rate:${userId}:${minute}` as const,

  // ── 签到 ──
  /** 某日签到用户集合（SET），key 中的 date 格式为 YYYY-MM-DD，用于签到日历查询 */
  checkinDate: (date: string) => `checkin:${date}:users` as const,

  // ── 积分 ──
  /** 用户当日某类积分发放累计计数，key 中 type 为 post|comment，date 为 YYYY-MM-DD [R1/R2] */
  pointDaily: (type: string, userId: number, date: string) => `point_daily:${type}:${userId}:${date}` as const,

  // ── 限流 ──
  /** API 限流计数 */
  rateLimit: (ip: string, endpoint: string) => `rate:${ip}:${endpoint}` as const,
} as const
