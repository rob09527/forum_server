/**
 * 业务枚举常量，禁止在业务代码中使用裸字符串。
 */

/** 用户等级（NodeSeek 鸡爪/鸡腿/鸡肉体系） */
export const UserLevel = {
  /** 鸡爪 — 新手 */
  CLAW: 'claw',
  /** 鸡腿 — 中级 */
  LEG: 'leg',
  /** 鸡肉 — 高级 */
  MEAT: 'meat',
} as const
export type UserLevelType = (typeof UserLevel)[keyof typeof UserLevel]

/**
 * 帖子板块历史常量（已迁移为 DB 驱动，见 categories 表 / category.service.ts）。
 * 保留仅作为默认 9 个板块的 seed 来源与兼容占位，业务代码不再引用（发帖校验与列表均走 DB）。
 */
export const Category = {
  /** 综合讨论 */
  GENERAL: 'general',
  /** 大模型 */
  LLM: 'llm',
  /** AI Agent */
  AGENT: 'agent',
  /** Prompt 工程 */
  PROMPT: 'prompt',
  /** AI 绘画 */
  ART: 'art',
  /** 开源模型 */
  OPENSOURCE: 'opensource',
  /** AI 工具 */
  TOOLS: 'tools',
  /** 论文解读 */
  PAPER: 'paper',
  /** 经验分享 */
  SHARE: 'share',
} as const
export type CategoryType = (typeof Category)[keyof typeof Category]

/** 板块中文名映射，用于前端展示和 /api/categories 响应 */
export const CategoryLabel: Record<CategoryType, string> = {
  [Category.GENERAL]: '综合讨论',
  [Category.LLM]: '大模型',
  [Category.AGENT]: 'AI Agent',
  [Category.PROMPT]: 'Prompt 工程',
  [Category.ART]: 'AI 绘画',
  [Category.OPENSOURCE]: '开源模型',
  [Category.TOOLS]: 'AI 工具',
  [Category.PAPER]: '论文解读',
  [Category.SHARE]: '经验分享',
}

/** 板块 emoji 图标，用于前端展示和 /api/categories 响应 */
export const CategoryIcon: Record<CategoryType, string> = {
  [Category.GENERAL]: '📂',
  [Category.LLM]: '🤖',
  [Category.AGENT]: '🔧',
  [Category.PROMPT]: '✍️',
  [Category.ART]: '🎨',
  [Category.OPENSOURCE]: '📦',
  [Category.TOOLS]: '🛠',
  [Category.PAPER]: '📄',
  [Category.SHARE]: '💡',
}

/** 排序方式 */
export const SortOrder = {
  /** 最新优先 */
  LATEST: 'latest',
  /** 最热优先 */
  HOT: 'hot',
} as const
export type SortOrderType = (typeof SortOrder)[keyof typeof SortOrder]

/**
 * 积分变动类型。收入侧见《积分签到等级体系.md》，消费侧见《积分消费体系.md》[R45]。
 * 三种通道各走各的写入函数，类型别名在下方按通道拆分，防止误用：
 * - earnPoints（收入）：同增余额与累计、可能升级
 * - spendPoints（消费）：只扣余额，永不触碰累计 [R44]
 * - creditPoints（转入）：只加余额，不计累计、不升级 [R50]
 */
export const PointType = {
  // ── 收入侧（存量，走 earnPoints，同时增加余额与累计）──
  /** 签到奖励 */
  CHECKIN: 'checkin',
  /** 发帖奖励 */
  POST: 'post',
  /** 评论奖励 */
  COMMENT: 'comment',
  /** 被点赞 */
  LIKED: 'liked',
  /** 积分转账 */
  TRANSFER: 'transfer',

  // ── 消费侧：扣余额，走 spendPoints，永不触碰累计 [R44] ──
  /** 装饰购买 / 续费 */
  SHOP: 'shop',
  /** 补签 [R52]（只扣分，不补发该日签到积分） */
  MAKEUP: 'makeup',
  /** 改名 */
  RENAME: 'rename',
  /** 上传扩容 */
  QUOTA: 'quota',
  /** 打赏支出 [R47] */
  TIP_OUT: 'tip_out',
  /** 悬赏托管扣款 */
  BOUNTY_OUT: 'bounty_out',

  // ── 转入侧：加余额，走 creditPoints，不计累计、不升级 [R50] ──
  /** 打赏收入 */
  TIP_IN: 'tip_in',
  /** 悬赏奖励到账（已扣除手续费） */
  BOUNTY_IN: 'bounty_in',
  /** 悬赏退款（零回答 / 发起人取消 / 后台人工退款，不抽水） */
  BOUNTY_REFUND: 'bounty_refund',
} as const
export type PointTypeType = (typeof PointType)[keyof typeof PointType]

/** 收入侧积分类型：走 earnPoints，同时增加余额与累计、可能升级 [2.1] */
export type IncomePointType =
  | typeof PointType.CHECKIN
  | typeof PointType.POST
  | typeof PointType.COMMENT
  | typeof PointType.LIKED
  | typeof PointType.TRANSFER

/** 消费侧积分类型：走 spendPoints，只扣余额、永不触碰累计 [R44] */
export type SpendPointType =
  | typeof PointType.SHOP
  | typeof PointType.MAKEUP
  | typeof PointType.RENAME
  | typeof PointType.QUOTA
  | typeof PointType.TIP_OUT
  | typeof PointType.BOUNTY_OUT

/** 转入侧积分类型：走 creditPoints，只加余额、不计累计、不升级 [R50] */
export type CreditPointType =
  | typeof PointType.TIP_IN
  | typeof PointType.BOUNTY_IN
  | typeof PointType.BOUNTY_REFUND

/** 用户管理角色 */
export const UserRole = {
  /** 普通用户 */
  USER: 'user',
  /** 版主 */
  MOD: 'mod',
  /** 管理员 */
  ADMIN: 'admin',
} as const
export type UserRoleType = (typeof UserRole)[keyof typeof UserRole]

/** 用户账号状态（封禁/禁言） */
export const UserStatus = {
  /** 正常 */
  ACTIVE: 'active',
  /** 封禁（禁止登录，踢下线） */
  BANNED: 'banned',
  /** 禁言（可登录，禁止发帖/评论） */
  MUTED: 'muted',
} as const
export type UserStatusType = (typeof UserStatus)[keyof typeof UserStatus]

/** 私信隐私开关（用户自选：谁能给我发私信） */
export const DmPrivacy = {
  /** 所有人可私信 */
  EVERYONE: 'everyone',
  /** 仅关注我的人可私信 */
  FOLLOWERS: 'followers',
  /** 关闭私信 */
  NOBODY: 'nobody',
} as const
export type DmPrivacyType = (typeof DmPrivacy)[keyof typeof DmPrivacy]

/** 允许的头像风格（本地预置头像目录，对应前端 public/avatars/ 子目录）。
 * 已弃用风格（croodles-neutral 涂鸦2 / notionists-neutral 印象2）头像文件已删除，不再允许。 */
export const ALLOWED_AVATAR_STYLES = [
  'bottts-neutral',
  'avataaars',
  'pixel-art',
  'identicon',
  'lorelei',
  'thumbs',
  'adventurer',
  'adventurer-neutral',
  'big-ears',
  'big-ears-neutral',
  'big-smile',
  'croodles',
  'fun-emoji',
  'micah',
  'miniavs',
  'notionists',
  'open-peeps',
  'personas',
] as const
export type AvatarStyleType = (typeof ALLOWED_AVATAR_STYLES)[number]

/** 每个风格的本地预置头像数量（avatar-01.svg ~ avatar-20.svg） */
export const AVATARS_PER_STYLE = 20

/**
 * 自定义上传头像的**服务端**强制限制（docs 交接快照 §9.2 / §13.1）。
 *
 * 为什么单独一组、而不是复用 config.UPLOAD_MAX_FILE_SIZE：
 * 全局上传上限默认 10MB 是给正文配图的，对头像过大（头像会在列表页一屏几十次并发取图）。
 * 头像必须有更小的独立上限 + 服务端等比压缩，**且校验只能在服务端做** ——
 * 前端 crop 再上传是体验优化，绕过前端直接 POST 就失效了。
 *
 * ⚠️ 这里是**默认值**。运营可改值将由 `config:limits`（§11.7 配置中枢）覆盖，
 * 中枢接入由持有 `config.service.ts` 的窗口负责；本常量始终是兜底默认。
 */
export const AVATAR_UPLOAD_LIMITS = {
  /**
   * 单张自定义头像的最大原始字节数。
   * 单位：字节；默认 2MB（2 * 1024 * 1024 = 2097152）。
   * 超过直接拒绝（ValidationError，人话提示），不做「先收下再压缩」。
   */
  maxFileSizeBytes: 2 * 1024 * 1024,
  /**
   * 头像的最大像素边长（宽、高各自的上限）。
   * 单位：像素；默认 512。超过则**服务端等比缩放**到边长 ≤ 该值（不放大小图），
   * 不是拒绝 —— 用户拍的照片普遍远大于 512，拒绝体验太差。
   */
  maxEdgePx: 512,
} as const

/** 公告类型（前台公告栏圆点颜色按此分类） */
export const AnnouncementType = {
  /** 普通 */
  NORMAL: 'normal',
  /** 重要 */
  IMPORTANT: 'important',
  /** 紧急 */
  URGENT: 'urgent',
  /** 活动 */
  ACTIVITY: 'activity',
} as const
export type AnnouncementTypeType = (typeof AnnouncementType)[keyof typeof AnnouncementType]

/** 广告位位置（前台渲染位置按此分类；top 顶部横幅已下线） */
export const AdvertPosition = {
  /** 侧边栏 */
  SIDEBAR: 'sidebar',
  /** 帖子列表内嵌 */
  INLINE: 'inline',
} as const
export type AdvertPositionType = (typeof AdvertPosition)[keyof typeof AdvertPosition]

/** OAuth 第三方来源 */
export const OAuthProvider = {
  /** Telegram */
  TELEGRAM: 'telegram',
} as const
export type OAuthProviderType = (typeof OAuthProvider)[keyof typeof OAuthProvider]

/** 站内通知类型 */
export const NotificationType = {
  /** 有人评论我的帖子（顶层评论） */
  COMMENT: 'comment',
  /** 有人回复我的评论（楼中楼） */
  REPLY: 'reply',
  /** 有人赞我的帖子/评论（同一目标聚合为一条） */
  LIKE: 'like',
  /** 有人关注我 */
  FOLLOW: 'follow',
  /** 系统通知（后台群发） */
  SYSTEM: 'system',
  /** 帖子/评论中 @ 提到了我（编辑器点选插入的结构化 mention） */
  MENTION: 'mention',
  /** 有人打赏我的帖子/评论（聚合：同一目标合并一条、actor 累加 [1.5.3]） */
  TIP: 'tip',
  /** 悬赏帖收到新回答，提醒发起人采纳 [1.6.5]（聚合：同帖合并、actor 累加） */
  BOUNTY_REPLY: 'bounty_reply',
  /** 悬赏已结算（采纳或超时判给；含被采纳者「获得 N🍗」）[1.6.5]（聚合：同帖合并） */
  BOUNTY_SETTLED: 'bounty_settled',
  /** 悬赏已退款（零有效回答 / 发起人取消 / 后台处置）[1.6.5]（聚合：同帖合并） */
  BOUNTY_REFUNDED: 'bounty_refunded',
} as const
export type NotificationTypeType = (typeof NotificationType)[keyof typeof NotificationType]

/** 后台系统通知的群发目标 */
export const SystemNotifyTarget = {
  /** 全部 active 用户 */
  ALL: 'all',
  /** 按角色筛选 */
  ROLE: 'role',
  /** 指定用户 ID 列表 */
  USERS: 'users',
} as const
export type SystemNotifyTargetType = (typeof SystemNotifyTarget)[keyof typeof SystemNotifyTarget]

/**
 * 装饰商品类型。同类互相覆盖（单槽）、不同类共存 [1.3.3]。
 * ⚠️ 历史上还有 avatar(头像)，已于 §9.1 下线：头像不再是付费商品（预置模板任选 + 自定义上传，均免费），
 * 枚举项一并删除 —— 留着会让后续维护者以为还存在付费头像链路。库里 360 行 type='avatar' 的商品行做软下架保留。
 */
export const ShopItemType = {
  /** 用户名颜色（CSS 色值/渐变） */
  USERNAME_COLOR: 'username_color',
  /** 专属称号（文本 + 徽章配色 key） */
  TITLE: 'title',
} as const
export type ShopItemTypeType = (typeof ShopItemType)[keyof typeof ShopItemType]

/** 称号徽章配色 key（对应 Tailwind class 前缀，admin 上架时填写，与前端 UsernameText 联动）[1.3.2] */
export const DecorationStyle = {
  /** 琥珀 */
  AMBER: 'amber',
  /** 紫罗兰 */
  VIOLET: 'violet',
  /** 祖母绿 */
  EMERALD: 'emerald',
} as const
export type DecorationStyleType = (typeof DecorationStyle)[keyof typeof DecorationStyle]

/** 悬赏状态机。状态流转一律条件更新（updateMany where status='escrow'），保证并发幂等 [2.5.3] */
export const BountyStatus = {
  /** 托管中：钱已扣、悬而未决，等待采纳或超时 */
  ESCROW: 'escrow',
  /** 已结算：采纳或超时判给，回答者已得款 */
  SETTLED: 'settled',
  /** 已退款：零有效回答 / 发起人取消 / 后台处置，全额退回发起人 */
  REFUNDED: 'refunded',
} as const
export type BountyStatusType = (typeof BountyStatus)[keyof typeof BountyStatus]

/** 悬赏状态中文名（后台列表与通知展示用） */
export const BountyStatusLabel: Record<BountyStatusType, string> = {
  [BountyStatus.ESCROW]: '托管中',
  [BountyStatus.SETTLED]: '已采纳',
  [BountyStatus.REFUNDED]: '已退款',
}

/** 悬赏结算方式（settleType 取值，记录在 bounties 表用于后台审计） */
export const BountySettleType = {
  /** 发起人人工采纳 [1.6.5] */
  ACCEPT: 'accept',
  /** 超时自动判给最高赞 / 零回答自动退款 [1.6.3] */
  AUTO: 'auto',
  /** 发起人取消（仅无有效回答时允许）[1.6.2] */
  CANCEL: 'cancel',
  /** 后台人工处置（退款）[2.5.5] */
  ADMIN: 'admin',
} as const
export type BountySettleTypeType = (typeof BountySettleType)[keyof typeof BountySettleType]
