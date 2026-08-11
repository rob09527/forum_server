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

/** 帖子板块 */
export const Category = {
  /** 日常 */
  DAILY: 'daily',
  /** 技术 */
  TECH: 'tech',
  /** 沙盒（灌水） */
  SANDBOX: 'sandbox',
} as const
export type CategoryType = (typeof Category)[keyof typeof Category]

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

/** OAuth 第三方来源 */
export const OAuthProvider = {
  /** Telegram */
  TELEGRAM: 'telegram',
} as const
export type OAuthProviderType = (typeof OAuthProvider)[keyof typeof OAuthProvider]
