import { ErrorCode } from '../constants/error-codes.js'

/**
 * 应用级错误基类。
 * service 层抛出，全局 error handler 统一捕获并返回标准响应。
 */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string,
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

/** 资源不存在，code 可选，默认通用 NOT_FOUND */
export class NotFoundError extends AppError {
  constructor(resource: string, code: string = ErrorCode.NOT_FOUND) {
    super(`${resource}不存在`, 404, code)
  }
}

/** 无权限，code 可选，默认通用 FORBIDDEN */
export class ForbiddenError extends AppError {
  constructor(message = '无权限', code: string = ErrorCode.FORBIDDEN) {
    super(message, 403, code)
  }
}

/** 参数校验失败，code 可选，默认通用 VALIDATION_ERROR */
export class ValidationError extends AppError {
  constructor(message: string, code: string = ErrorCode.VALIDATION_ERROR) {
    super(message, 400, code)
  }
}

/** 资源冲突（如重复注册） */
export class ConflictError extends AppError {
  constructor(message: string, code: string = ErrorCode.CONFLICT) {
    super(message, 409, code)
  }
}

/** 未登录或 token 无效 */
export class UnauthorizedError extends AppError {
  constructor(message = '请先登录', code: string = ErrorCode.UNAUTHORIZED) {
    super(message, 401, code)
  }
}

/** 登录凭据错误（邮箱或密码错） */
export class InvalidCredentialsError extends AppError {
  constructor() {
    // 不区分"用户不存在"和"密码错误"，防止邮箱枚举攻击
    super('邮箱或密码错误', 401, ErrorCode.INVALID_CREDENTIALS)
  }
}

/**
 * 余额不足。由 spendPoints 的条件更新（WHERE points >= amount 命中 0 行）抛出 [R44][1.8]。
 * message 拼「余额不足，还差 N 🍗」，前端据 code 弹「去签到 →」引导（产品 1.10）。
 */
export class InsufficientPointsError extends AppError {
  constructor(have: number, needed: number) {
    super(`余额不足，还差 ${needed - have} 🍗`, 400, ErrorCode.INSUFFICIENT_POINTS)
  }
}

/** 导入 worker 丢失 Redis 租约；调用方应中止本轮，避免旧 worker 继续写入。 */
export class ImportLockLostError extends AppError {
  constructor() {
    super('导入任务锁已失效，本轮已中止', 503, ErrorCode.IMPORT_LOCK_LOST)
  }
}
