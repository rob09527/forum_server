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
  /** 待确认头像资源归属，value 为上传用户 ID，短 TTL 防止未确认文件长期占用磁盘 */
  /** 待确认头像资源索引（SET），用于 key TTL 到期后的磁盘清理 */
  pendingAvatarIndex: 'upload:pending-avatar:index' as const,
  /** 待确认头像资源 key 前缀，用于运维排查 */
  pendingAvatarPrefix: 'upload:pending-avatar:' as const,
  pendingAvatar: (relativePath: string) =>
    `upload:pending-avatar:${Buffer.from(relativePath).toString('base64url')}` as const,

  // ── 签到 ──
  /** 某日签到用户集合（SET），key 中的 date 格式为 YYYY-MM-DD，用于签到日历查询 */
  checkinDate: (date: string) => `checkin:${date}:users` as const,

  // ── 通知 ──
  /** 用户未读通知数（Redis 计数器，避免每事件 COUNT；已读时 DEL 兜底对账） */
  unreadCount: (userId: number) => `user:${userId}:unread_count` as const,

  // ── 私信 ──
  /** 用户未读私信总数（顶栏红点，Redis 计数器；已读时 DECR 兜底对账） */
  dmUnread: (userId: number) => `dm:${userId}:unread` as const,
  /** 私信发送限流计数，key 中 minute 格式为 YYYYMMDDHHMM */
  dmRate: (userId: number, minute: string) => `dm_rate:${userId}:${minute}` as const,

  // ── 积分 ──
  /** 用户当日某类积分发放累计计数，key 中 type 为 post|comment，date 为 YYYY-MM-DD [R1/R2] */
  pointDaily: (type: string, userId: number, date: string) => `point_daily:${type}:${userId}:${date}` as const,

  // ── 限流 ──
  /** API 限流计数 */
  rateLimit: (ip: string, endpoint: string) => `rate:${ip}:${endpoint}` as const,

  // ── 游戏化配置 ──
  /**
   * 签到奖励配置（JSON 字符串），由 admin 后端直写共享 Redis，forum 只读 + 默认兜底。
   * 未配置/非法时用 config.service 的 DEFAULT_CHECKIN_CONFIG。
   */
  configCheckin: 'config:checkin',
  /**
   * 等级配置（JSON 数组字符串），由 admin 后端直写共享 Redis，forum 只读 + 默认兜底。
   * 未配置/非法时用 config.service 的 DEFAULT_LEVELS。
   */
  configLevels: 'config:levels',
  /**
   * 商城配置（JSON 字符串），admin 直写共享 Redis，forum 只读 + 默认兜底 [2.6]。
   * 未配置/非法时用 config.service 的 DEFAULT_SHOP_CONFIG。
   */
  configShop: 'config:shop',
  /**
   * 打赏配置（JSON 字符串），admin 直写共享 Redis，forum 只读 + 默认兜底 [2.6]。
   * 未配置/非法时用 config.service 的 DEFAULT_TIP_CONFIG。
   */
  configTip: 'config:tip',
  /**
   * 悬赏配置（JSON 字符串），admin 直写共享 Redis，forum 只读 + 默认兜底 [2.6]。
   * 未配置/非法时用 config.service 的 DEFAULT_BOUNTY_CONFIG。
   */
  configBounty: 'config:bounty',
  /**
   * 功能道具配置（JSON 字符串），admin 直写共享 Redis，forum 只读 + 默认兜底 [2.6]。
   * 未配置/非法时用 config.service 的 DEFAULT_PROPS_CONFIG。
   */
  configProps: 'config:props',
  /**
   * 频率/大小限制配置（JSON 字符串），第 7 组。收拢原先散落四处的限流与体积上限
   * （环境变量 / `app.ts` 硬编码 / `message.service.ts` 模块常量），见交接快照 §11.7。
   * 未配置/非法时用 config.service 的 DEFAULT_LIMITS_CONFIG（其上传三项以环境变量为默认值）。
   */
  configLimits: 'config:limits',
  /**
   * NodeLoc 导入同步配置（JSON 字符串），第 8 组。worker 启停开关热切换。
   * 未配置/非法时用 config.service 的 DEFAULT_NODELOC_CONFIG（其 syncEnabled 以环境变量 IMPORT_SYNC_ENABLED 为默认值）。
   */
  configNodeloc: 'config:nodeloc',
  /**
   * 配置失效广播频道（pub/sub）。message 为该组的 Redis key（如 `config:limits`）或 `*`（全部失效）。
   *
   * 为什么需要它:配置读取带进程内缓存（见 services/config/config-cache.ts），
   * 而生产 forum 是多实例（docker-compose）。admin 的一次写只命中其中一台，
   * 其余实例的进程内缓存不会失效 → 经典的「后台改了、前台不生效」。
   * 写入方 publish、每个实例各自 subscribe，即时失效；pub/sub 不保证投递，
   * 故缓存另有软 TTL 兜底（详见 config-cache.ts）。
   */
  configInvalidateChannel: 'config:invalidate',

  // ── 悬赏 ──
  /** 悬赏超时结算的分布式锁（SET NX EX 60）。保证多实例只有一个执行 sweep [2.5.3] */
  bountySweepLock: 'bounty:sweep:lock',

  // ── NodeLoc 数据导入 ──
  /** 增量同步分布式锁（SET NX EX 180），保证多实例只有一个执行回灌/造数/增量 */
  importSyncLock: 'import:sync:lock',
  /** 增量同步游标：已处理的对方最大 post id（字符串数字） */
  importCursor: (source: string) => `import:${source}:cursor` as const,
  /**
   * 同步阶段标记（STRING）：backfill | fabricate | incremental。
   * 由 runImportSync 显式写入，让三阶段状态机跨进程重启可恢复；
   * 不靠「读数据现状」每次重推断——否则回填到一半重启，会被误判成已完成而跳过剩余回填。
   */
  importPhase: (source: string) => `import:${source}:phase` as const,
  /**
   * 回填页游标（STRING）：下一个要处理的 /latest.json?order=created 页码。
   * 替代旧脚本的文件断点 .import-backfill-checkpoint.json，随 worker 一起存 Redis。
   */
  importBackfillPage: (source: string) => `import:${source}:backfill-page` as const,

  // ── 装饰 ──
  /** 装饰到期提醒的分布式锁（SET NX EX 60）。保证多实例只有一个扫描今日到期 [T2] */
  decorationRemindLock: 'decoration:remind:lock',
} as const
