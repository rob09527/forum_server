import type { FastifyReply } from 'fastify'

/**
 * 统一响应格式。
 * 所有路由必须使用 sendSuccess / sendError，禁止直接 return { success: true, ... }。
 *
 * 成功响应：{ success: true, data: T }
 * 错误响应：{ success: false, error: { code: string, message: string } }
 */

/** 成功响应 */
export function sendSuccess<T>(reply: FastifyReply, data: T, statusCode = 200): void {
  reply.status(statusCode).send({ success: true, data })
}

/** 错误响应 */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): void {
  reply.status(statusCode).send({
    success: false,
    error: { code, message },
  })
}
