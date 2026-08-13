import type { FastifyRequest } from 'fastify'
import { ErrorCode } from '../constants/error-codes.js'
import { AppError } from '../utils/errors.js'

/** 写方法：这些方法改变服务端状态，是 CSRF 的攻击面 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * 返回一个 onRequest 钩子，校验写操作的 Origin/Referer，作为 CSRF 纵深防御。
 *
 * 注意：必须以 `fastify.addHook('onRequest', csrfGuard(origins))` 直接挂在 root 实例上，
 * 不能包成 `register` 插件——Fastify 会给插件创建子上下文，钩子会被封装在子上下文里，
 * 只作用于插件内的路由，作用不到后续注册的全局路由。
 *
 * 认证用的是 session cookie（httpOnly + SameSite=lax），SameSite=lax 已能挡住跨站 POST/PUT，
 * 这里再加一道 Origin/Referer 校验作为第二重防线：
 * - 只对写方法生效（GET 等读操作无副作用，不需要校验）
 * - 请求头里没有 Origin/Referer 时不阻断（curl、服务端调用、同源 GET 导航，交给 SameSite 兜底）
 * - 有 Origin/Referer 但与 allowlist 不匹配 → 403
 */
export function csrfGuard(allowedOrigins: string[]): (request: FastifyRequest) => Promise<void> {
  const allowed = new Set(allowedOrigins)

  return async function csrfGuardHook(request: FastifyRequest): Promise<void> {
    if (!UNSAFE_METHODS.has(request.method)) return

    const rawOrigin = request.headers.origin ?? request.headers.referer
    if (!rawOrigin) return

    let origin: string
    try {
      origin = new URL(rawOrigin).origin
    } catch {
      // Origin/Referer 无法解析时不阻断（异常 header 交给 SameSite 兜底）
      return
    }

    if (!allowed.has(origin)) {
      throw new AppError('跨站请求被拒绝', 403, ErrorCode.CSRF_REJECTED)
    }
  }
}
