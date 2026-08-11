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
} as const

/** 所有错误码的联合类型 */
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode]
