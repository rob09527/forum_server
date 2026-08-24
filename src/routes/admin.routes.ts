import type { FastifyInstance } from 'fastify'
import {
  adminChangeRole,
  adminChangeStatus,
  adminAdjustPoints,
  adminResetPassword,
} from '../services/admin/admin.service.js'
import { deletePostById } from '../services/post/post.service.js'
import { broadcastSystemNotification } from '../services/notification/notification.service.js'
import { requireAdminKey } from '../middleware/admin-key.middleware.js'
import { UserRole, UserStatus, SystemNotifyTarget } from '../constants/business.js'
import type { SystemNotifyTargetType } from '../constants/business.js'
import { parseId } from '../utils/parse.js'
import { sendSuccess } from '../utils/response.js'

/**
 * 管理端接口（供 Cool Admin 后端调用，非浏览器直接访问）。
 * 统一 preHandler 校验 X-Admin-Key 服务间密钥；真正的后台权限控制由 admin 后端负责。
 */
export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/admin/users/:id/role
   * 改角色。Body: { role: 'user' | 'mod' | 'admin' }
   */
  fastify.post(
    '/api/admin/users/:id/role',
    {
      preHandler: [requireAdminKey],
      schema: {
        body: {
          type: 'object',
          required: ['role'],
          properties: { role: { type: 'string', enum: Object.values(UserRole) } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { role } = request.body as { role: string }
      const userId = parseId(id)
      const result = await adminChangeRole(userId, role)
      sendSuccess(reply, result)
    },
  )

  /**
   * POST /api/admin/users/:id/status
   * 封禁/解封/禁言。Body: { status: 'active' | 'banned' | 'muted' }，banned 会踢下线。
   */
  fastify.post(
    '/api/admin/users/:id/status',
    {
      preHandler: [requireAdminKey],
      schema: {
        body: {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', enum: Object.values(UserStatus) } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { status } = request.body as { status: string }
      const userId = parseId(id)
      const result = await adminChangeStatus(userId, status)
      sendSuccess(reply, result)
    },
  )

  /**
   * POST /api/admin/users/:id/points
   * 调积分（可负）。Body: { delta: number, operator?: string }
   * operator 为操作者用户名（admin 后端从登录会话透传），写入 transfer 流水供审计追责。
   */
  fastify.post(
    '/api/admin/users/:id/points',
    {
      preHandler: [requireAdminKey],
      schema: {
        body: {
          type: 'object',
          required: ['delta'],
          properties: {
            delta: { type: 'integer' },
            operator: { type: 'string', maxLength: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { delta, operator } = request.body as { delta: number; operator?: string }
      const userId = parseId(id)
      const result = await adminAdjustPoints(userId, delta, operator)
      sendSuccess(reply, result)
    },
  )

  /**
   * POST /api/admin/users/:id/password
   * 重置密码。Body: { password: string }，至少 8 位。
   */
  fastify.post(
    '/api/admin/users/:id/password',
    {
      preHandler: [requireAdminKey],
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: { password: { type: 'string', minLength: 8 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { password } = request.body as { password: string }
      const userId = parseId(id)
      const result = await adminResetPassword(userId, password)
      sendSuccess(reply, result)
    },
  )

  /**
   * POST /api/admin/posts/:id/delete
   * 删除帖子（硬删），级联删评论/点赞并清理图片，作者发帖数 -1。
   */
  fastify.post(
    '/api/admin/posts/:id/delete',
    {
      preHandler: [requireAdminKey],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const postId = parseId(id)
      await deletePostById(postId)
      sendSuccess(reply, { id: postId })
    },
  )

  /**
   * POST /api/admin/notifications/broadcast
   * 系统通知群发。Body: { target: 'all'|'role'|'users', role?, userIds?, content, postId? }
   * 写 type=system 通知给目标用户，在线用户实时推送 SSE。
   */
  fastify.post(
    '/api/admin/notifications/broadcast',
    {
      preHandler: [requireAdminKey],
      schema: {
        body: {
          type: 'object',
          required: ['target', 'content'],
          properties: {
            target: { type: 'string', enum: Object.values(SystemNotifyTarget) },
            role: { type: 'string' },
            userIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
            content: { type: 'string', minLength: 1, maxLength: 2000 },
            postId: { type: ['integer', 'null'], minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        target: string
        role?: string
        userIds?: number[]
        content: string
        postId?: number | null
      }

      const result = await broadcastSystemNotification({
        target: body.target as SystemNotifyTargetType,
        role: body.role,
        userIds: body.userIds,
        content: body.content,
        postId: body.postId ?? null,
      })
      sendSuccess(reply, result)
    },
  )
}
