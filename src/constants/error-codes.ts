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

  // ── 签到 ──
  /** 今天已经签到过了 */
  ALREADY_CHECKED_IN: 'ALREADY_CHECKED_IN',

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
