/**
 * 所有 API 错误码集中定义。
 * 使用 as const 确保不可变 + 可推导出 ErrorCodeType 联合类型。
 */
export const ErrorCode = {
  // ── 通用 ──
  /** 服务器内部错误，不暴露详情给客户端 */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** 请求参数校验失败 */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** 资源不存在 */
  NOT_FOUND: 'NOT_FOUND',
  /** 无权限访问 */
  FORBIDDEN: 'FORBIDDEN',
  /** 资源冲突（如重复注册） */
  CONFLICT: 'CONFLICT',
  /** 请求过于频繁 */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 跨站请求伪造（Origin/Referer 校验失败） */
  CSRF_REJECTED: 'CSRF_REJECTED',

  // ── 认证 ──
  /** 邮箱或密码错误（不区分具体原因，防枚举） */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** 未登录或 token 无效 */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** 邮箱已被注册 */
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  /** 用户名已被占用 */
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  /** TG 授权数据验签失败 */
  INVALID_TELEGRAM_AUTH: 'INVALID_TELEGRAM_AUTH',
  /** 账号已被封禁 */
  ACCOUNT_BANNED: 'ACCOUNT_BANNED',
  /** 账号已被禁言 */
  ACCOUNT_MUTED: 'ACCOUNT_MUTED',

  // ── 签到 ──
  /** 今天已经签到过了 */
  ALREADY_CHECKED_IN: 'ALREADY_CHECKED_IN',
  /** 补签不可用（今天已签/昨天已签/断签超 1 天） */
  MAKEUP_UNAVAILABLE: 'MAKEUP_UNAVAILABLE',
  /** 本月补签次数已达上限 */
  MAKEUP_LIMIT_EXCEEDED: 'MAKEUP_LIMIT_EXCEEDED',

  // ── 积分消费 ──
  /** 余额不足（InsufficientPointsError，附带还差 N 🍗） */
  INSUFFICIENT_POINTS: 'INSUFFICIENT_POINTS',
  /** 改名冷却中（RENAME_COOLDOWN 天 1 次） */
  RENAME_COOLDOWN: 'RENAME_COOLDOWN',
  /** 上传扩容已达总量上限 */
  QUOTA_LIMIT_EXCEEDED: 'QUOTA_LIMIT_EXCEEDED',

  // ── 装饰商城 ──
  /** 商品不存在 */
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  /** 商品已下架 */
  ITEM_NOT_ACTIVE: 'ITEM_NOT_ACTIVE',
  /**
   * @deprecated 商城头像模块已下架（§9.1）：抛出它的那条付费分支（updateAvatar 里查 UserDecoration
   * 判持有）已删除,服务端已无任何抛出点。**保留仅为对外契约兼容**,理由同 AVATAR_FREE_PURCHASE。
   * ⛔ 新代码不得使用。
   * 原语义：该头像需在商城购买解锁（付费头像未持有）。
   */
  AVATAR_LOCKED: 'AVATAR_LOCKED',
  IMPORT_LOCK_LOST: 'IMPORT_LOCK_LOST',
  /**
   * @deprecated 商城头像模块已下架（§9.1）：头像不再是付费商品（预置模板任选 + 自定义上传，均免费），
   * 服务端已无任何代码抛出该码。**保留仅为对外契约兼容** —— 错误码是契约，前端/后台可能已在分支里
   * 判过它，静默删除等于行为变更。⛔ 新代码不得使用。
   * 原语义：免费池头像不可购买（永久有效，直接在个人资料选择）。
   */
  AVATAR_FREE_PURCHASE: 'AVATAR_FREE_PURCHASE',

  // ── 打赏 ──
  /** 该内容已经打赏过了（每人每内容一次 [R48]） */
  ALREADY_TIPPED: 'ALREADY_TIPPED',
  /** 不能打赏自己的内容 [R49] */
  CANNOT_TIP_SELF: 'CANNOT_TIP_SELF',
  /** 打赏金额不在允许区间（或超出日额度） */
  TIP_AMOUNT_INVALID: 'TIP_AMOUNT_INVALID',

  // ── 悬赏 ──
  /** 悬赏金额不在配置区间 */
  BOUNTY_AMOUNT_INVALID: 'BOUNTY_AMOUNT_INVALID',
  /** 同时进行的悬赏数已达上限 */
  BOUNTY_LIMIT_EXCEEDED: 'BOUNTY_LIMIT_EXCEEDED',
  /** 悬赏已结算/已有有效回答（取消/采纳失败） */
  BOUNTY_ALREADY_SETTLED: 'BOUNTY_ALREADY_SETTLED',
  /** 采纳对象必须是该帖的有效回答（顶层且非发起人自答） */
  BOUNTY_ACCEPT_INVALID: 'BOUNTY_ACCEPT_INVALID',

  // ── 帖子 ──
  /** 帖子不存在 */
  POST_NOT_FOUND: 'POST_NOT_FOUND',
  /** 帖子标题为空或超长 */
  POST_TITLE_INVALID: 'POST_TITLE_INVALID',
  /** 正文过短（低于最小长度） */
  POST_CONTENT_TOO_SHORT: 'POST_CONTENT_TOO_SHORT',
  /** 板块无效 */
  POST_CATEGORY_INVALID: 'POST_CATEGORY_INVALID',
  /** 标签数量超限 */
  POST_TAGS_INVALID: 'POST_TAGS_INVALID',
  /** 非作者本人操作 */
  POST_NOT_OWNER: 'POST_NOT_OWNER',

  // ── 评论 ──
  /** 评论不存在 */
  COMMENT_NOT_FOUND: 'COMMENT_NOT_FOUND',
  /** 评论内容过短 */
  COMMENT_CONTENT_TOO_SHORT: 'COMMENT_CONTENT_TOO_SHORT',
  /** 回复的评论不属于该帖子 */
  COMMENT_PARENT_MISMATCH: 'COMMENT_PARENT_MISMATCH',
  /** 非评论作者本人操作 */
  COMMENT_NOT_OWNER: 'COMMENT_NOT_OWNER',

  // ── 点赞 ──
  /** 已经点过赞了 */
  ALREADY_LIKED: 'ALREADY_LIKED',
  /** 还没有点赞，无法取消 */
  NOT_LIKED: 'NOT_LIKED',

  // ── 收藏 ──
  /** 已经收藏过了 */
  ALREADY_BOOKMARKED: 'ALREADY_BOOKMARKED',
  /** 还没收藏，无法取消 */
  NOT_BOOKMARKED: 'NOT_BOOKMARKED',

  // ── 关注 ──
  /** 不能关注自己 */
  CANNOT_FOLLOW_SELF: 'CANNOT_FOLLOW_SELF',
  /** 已经关注过了 */
  ALREADY_FOLLOWING: 'ALREADY_FOLLOWING',
  /** 还没关注，无法取关 */
  NOT_FOLLOWING: 'NOT_FOLLOWING',

  // ── 通知 ──
  /** 通知不存在 */
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',

  // ── 私信 ──
  /** 不能给自己发私信 */
  DM_SELF: 'DM_SELF',
  /** 不符合对方私信门槛（对方关闭私信 / 仅关注的人可私信） */
  DM_FORBIDDEN: 'DM_FORBIDDEN',
  /** 会话不存在 */
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  /** 私信内容为空或超长 */
  DM_CONTENT_INVALID: 'DM_CONTENT_INVALID',
  /** 私信发送过于频繁 */
  DM_RATE_LIMITED: 'DM_RATE_LIMITED',

  // ── 上传 ──
  /** 没有收到文件 */
  UPLOAD_NO_FILE: 'UPLOAD_NO_FILE',
  /** 文件类型不支持 */
  UPLOAD_INVALID_TYPE: 'UPLOAD_INVALID_TYPE',
  /** 单文件超过大小限制 */
  UPLOAD_FILE_TOO_LARGE: 'UPLOAD_FILE_TOO_LARGE',
  /** 上传过于频繁 */
  UPLOAD_RATE_LIMITED: 'UPLOAD_RATE_LIMITED',
  /** 用户总上传量已达上限 */
  UPLOAD_USER_TOTAL_EXCEEDED: 'UPLOAD_USER_TOTAL_EXCEEDED',
  /** 图片处理失败 */
  UPLOAD_PROCESS_FAILED: 'UPLOAD_PROCESS_FAILED',
} as const

/** 所有错误码的联合类型 */
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode]
