import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifyToken, SESSION_COOKIE } from '../services/auth/auth-token.service.js'
import { getUserById } from '../services/auth/auth.service.js'
import { UnauthorizedError, ForbiddenError } from '../utils/errors.js'
import { ErrorCode } from '../constants/error-codes.js'
import type { UserPublic } from '../services/auth/auth.service.js'

/**
 * 扩展 FastifyRequest，挂载当前用户和 token。
 * 通过 auth.decorator.ts 注册到 Fastify 类型系统中。
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** 当前登录用户的公开信息；未登录时为 undefined */
    user?: UserPublic
    /** 当前 session token（cookie 中的原始值）；未登录时为 undefined */
    token?: string
  }
}

/**
 * 必须登录的中间件。
 * 未登录返回 401。
 */
export async function authenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE]

  if (!token) {
    throw new UnauthorizedError()
  }

  const userId = await verifyToken(token)
  if (!userId) {
    throw new UnauthorizedError()
  }

  const user = await getUserById(userId)
  if (!user) {
    // token 有效但用户被删了
    throw new UnauthorizedError()
  }

  // 封禁账号即使 token 未过期也拒绝访问（登录时已拦，这里是已登录请求的第二道闸）
  if (user.status === 'banned') {
    throw new ForbiddenError('账号已被封禁', ErrorCode.ACCOUNT_BANNED)
  }

  request.user = user
  request.token = token
}

/**
 * 可选登录的中间件。
 * 有 token 就挂载用户，没有也不报错。
 * 用于"登录后显示不同内容但未登录也能看"的接口。
 */
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE]

  if (!token) return

  const userId = await verifyToken(token)
  if (!userId) return

  const user = await getUserById(userId)
  if (!user) return

  request.user = user
  request.token = token
}
