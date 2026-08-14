import type { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { ForbiddenError } from '../utils/errors.js'

/**
 * 服务间密钥校验中间件。
 * 供 /api/admin/* 内部管理接口使用，校验 X-Admin-Key 请求头。
 * 与用户级 authenticate 不同，这里验证的是「admin 后端」这个调用方身份，
 * 而非某个具体的 forum 用户；真正的后台权限控制由 admin 后端（Cool Admin）负责。
 */
export async function requireAdminKey(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const key = request.headers['x-admin-key']
  if (!key || key !== config.FORUM_ADMIN_KEY) {
    throw new ForbiddenError('无管理权限')
  }
}
