import type { FastifyInstance } from 'fastify'
import {
  adminChangeRole,
  adminChangeStatus,
  adminAdjustPoints,
  adminResetPassword,
} from '../services/admin/admin.service.js'
import { adminRefundBounty } from '../services/bounty/bounty.service.js'
import { sweepExpiredBounties } from '../services/bounty/bounty-sweep.js'
import { deletePostById } from '../services/post/post.service.js'
import { broadcastSystemNotification } from '../services/notification/notification.service.js'
import {
  getAllConfigs,
  setConfig,
  resetConfig,
  getLevels,
  CONFIG_GROUP_NAMES,
} from '../services/config/config.service.js'
import type { ConfigGroup } from '../services/config/config.service.js'
import { recomputeLevels } from '../services/points/points.service.js'
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

  /**
   * POST /api/admin/bounties/:id/refund
   * 悬赏人工退款（处置异常悬赏 [2.4]）。Body: { operator?: string }（admin 后端会话透传的用户名）。
   * forceRefund 语义在 service 内固定开启：无条件退款（跳过「是否有有效回答」判定），全额退给发起人，不抽水。
   */
  fastify.post(
    '/api/admin/bounties/:id/refund',
    {
      preHandler: [requireAdminKey],
      schema: {
        body: {
          type: 'object',
          properties: { operator: { type: 'string', maxLength: 50 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { operator } = request.body as { operator?: string }
      const bountyId = parseId(id)
      await adminRefundBounty(bountyId, operator)
      sendSuccess(reply, { id: bountyId })
    },
  )

  /**
   * POST /api/admin/bounties/sweep
   * 手动触发超时结算（正常情况下 60s 调度器会自动跑，此接口用于验收/补扫）。
   * 返回本次结算条数（0 表示已被其他实例抢占锁或本无到期悬赏）。
   */
  fastify.post(
    '/api/admin/bounties/sweep',
    {
      preHandler: [requireAdminKey],
    },
    async (_request, reply) => {
      const swept = await sweepExpiredBounties()
      sendSuccess(reply, { swept })
    },
  )

  /**
   * GET /api/admin/config
   * 读取 6 组配置的已解析生效值（zod 校验 + 默认兜底后的真实值），admin 表单据此初始化。
   * 配置契约（key/schema/默认值）只存 forum 侧，admin 不再直连 Redis 手抄。
   */
  fastify.get(
    '/api/admin/config',
    { preHandler: [requireAdminKey] },
    async (_request, reply) => {
      sendSuccess(reply, await getAllConfigs())
    },
  )

  /**
   * PUT /api/admin/config/:group
   * 写入一组配置（组名见 CONFIG_GROUP_NAMES）。
   * 先按本组 zod schema 校验，非法值返回 400 不落库；校验通过后直写共享 Redis。
   */
  fastify.put(
    '/api/admin/config/:group',
    {
      preHandler: [requireAdminKey],
      schema: {
        params: {
          type: 'object',
          required: ['group'],
          properties: {
            // 组名枚举从 config.service 导出的单一事实来源取，别再手抄（新增第 7 组 limits 时两处都会漏）
            group: { type: 'string', enum: CONFIG_GROUP_NAMES },
          },
        },
      },
    },
    async (request, reply) => {
      const { group } = request.params as { group: ConfigGroup }
      await setConfig(group, request.body)
      // 等级配置保存后重算存量用户 level（删档/改门槛后 level 不滞后）
      if (group === 'levels') await recomputeLevels(await getLevels())
      sendSuccess(reply, { group })
    },
  )

  /**
   * DELETE /api/admin/config/:group
   * 恢复某组配置为默认值：删除 Redis key，forum 侧自动回退代码内置默认值。
   */
  fastify.delete(
    '/api/admin/config/:group',
    {
      preHandler: [requireAdminKey],
      schema: {
        params: {
          type: 'object',
          required: ['group'],
          properties: {
            // 组名枚举从 config.service 导出的单一事实来源取，别再手抄（新增第 7 组 limits 时两处都会漏）
            group: { type: 'string', enum: CONFIG_GROUP_NAMES },
          },
        },
      },
    },
    async (request, reply) => {
      const { group } = request.params as { group: ConfigGroup }
      await resetConfig(group)
      sendSuccess(reply, { group })
    },
  )
}
