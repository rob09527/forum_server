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

/** 资源不存在 */
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource}不存在`, 404, ErrorCode.NOT_FOUND)
  }
}

/** 无权限 */
export class ForbiddenError extends AppError {
  constructor(message = '无权限') {
    super(message, 403, ErrorCode.FORBIDDEN)
  }
}

/** 参数校验失败 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, ErrorCode.VALIDATION_ERROR)
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
