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

/** 积分变动类型 */
export const PointType = {
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
} as const
export type PointTypeType = (typeof PointType)[keyof typeof PointType]

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

/** 允许的头像风格（本地预置头像目录，对应前端 public/avatars/ 子目录） */
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
  'croodles-neutral',
  'fun-emoji',
  'micah',
  'miniavs',
  'notionists',
  'notionists-neutral',
  'open-peeps',
  'personas',
] as const
export type AvatarStyleType = (typeof ALLOWED_AVATAR_STYLES)[number]

/** 每个风格的本地预置头像数量（avatar-01.svg ~ avatar-20.svg） */
export const AVATARS_PER_STYLE = 20

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
