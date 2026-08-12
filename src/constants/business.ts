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

/** 帖子板块（前后端统一，由后端常量控制） */
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

/** 通知类型 */
export const NotificationType = {
  /** @提及 */
  MENTION: 'mention',
  /** 评论回复 */
  REPLY: 'reply',
  /** 系统通知 */
  SYSTEM: 'system',
} as const
export type NotificationTypeType = (typeof NotificationType)[keyof typeof NotificationType]

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

/** 允许的 DiceBear 头像风格（9.x 版本） */
export const ALLOWED_AVATAR_STYLES = [
  'bottts-neutral',
  'avataaars',
  'pixel-art',
  'identicon',
  'lorelei',
  'thumbs',
  'rings',
  'shapes',
  'adventurer',
  'adventurer-neutral',
  'big-ears',
  'big-ears-neutral',
  'big-smile',
  'croodles',
  'croodles-neutral',
  'fun-emoji',
  'glass',
  'micah',
  'miniavs',
  'notionists',
  'notionists-neutral',
  'open-peeps',
  'personas',
] as const
export type AvatarStyleType = (typeof ALLOWED_AVATAR_STYLES)[number]

/** OAuth 第三方来源 */
export const OAuthProvider = {
  /** Telegram */
  TELEGRAM: 'telegram',
} as const
export type OAuthProviderType = (typeof OAuthProvider)[keyof typeof OAuthProvider]
