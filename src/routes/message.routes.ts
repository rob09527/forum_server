import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { UnauthorizedError } from '../utils/errors.js'
import { parseId } from '../utils/parse.js'
import type { UserPublic } from '../services/auth/auth.service.js'
import {
  getDmPrivacy,
  setDmPrivacy,
  getOrCreateConversation,
  listConversations,
  listMessages,
  sendMessage,
  markRead,
  dmUnreadTotal,
} from '../services/message/message.service.js'
import type { DmPrivacyType } from '../constants/business.js'

/**
 * 用户私信路由。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */

/** 当前登录用户（authenticate 挂载后非空，兜底类型收窄） */
function requireUser(request: FastifyRequest): UserPublic {
  if (!request.user) {
    throw new UnauthorizedError()
  }
  return request.user
}

export async function messageRoutes(fastify: FastifyInstance): Promise<void> {
  /** 未读私信总数（顶栏红点） */
  fastify.get('/api/me/conversations/unread-count', { preHandler: [authenticate] }, async (request, reply) => {
    const count = await dmUnreadTotal(request.user!.id)
    sendSuccess(reply, { count })
  })

  /** 会话列表（分页，仅含有消息的会话） */
  fastify.get('/api/me/conversations', { preHandler: [authenticate] }, async (request, reply) => {
    const query = request.query as { page?: number; pageSize?: number }
    const result = await listConversations(
      request.user!.id,
      query.page ? Number(query.page) : 1,
      query.pageSize ? Number(query.pageSize) : 20,
    )
    sendSuccess(reply, result)
  })

  /** 建立/获取会话（首次应用隐私门槛） */
  fastify.post('/api/me/conversations', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { userId: number }
    const conversation = await getOrCreateConversation(request.user!.id, body.userId)
    sendSuccess(reply, conversation)
  })

  /** 会话消息分页（游标分页，升序） */
  fastify.get('/api/me/conversations/:id/messages', {
    preHandler: [authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer', minimum: 1 } },
      },
      querystring: {
        type: 'object',
        properties: {
          beforeId: { type: 'integer', minimum: 1 },
          pageSize: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const query = request.query as { beforeId?: number; pageSize?: number }
    const messages = await listMessages(
      request.user!.id,
      parseId(id),
      query.beforeId ? Number(query.beforeId) : undefined,
      query.pageSize ? Number(query.pageSize) : undefined,
    )
    sendSuccess(reply, messages)
  })

  /** 发送私信 */
  fastify.post('/api/me/conversations/:id/messages', {
    preHandler: [authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
  }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = request.body as { content: string }
    const message = await sendMessage(user.id, parseId(id), body.content)
    sendSuccess(reply, message, 201)
  })

  /** 标记会话已读 */
  fastify.post('/api/me/conversations/:id/read', {
    preHandler: [authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await markRead(request.user!.id, parseId(id))
    sendSuccess(reply, result)
  })

  /** 查询本人私信隐私开关 */
  fastify.get('/api/me/dm-privacy', { preHandler: [authenticate] }, async (request, reply) => {
    const privacy = await getDmPrivacy(request.user!.id)
    sendSuccess(reply, { privacy })
  })

  /** 更新本人私信隐私开关 */
  fastify.put('/api/me/dm-privacy', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['privacy'],
        properties: {
          privacy: { type: 'string', enum: ['everyone', 'followers', 'nobody'] },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { privacy: DmPrivacyType }
    const privacy = await setDmPrivacy(request.user!.id, body.privacy)
    sendSuccess(reply, { privacy })
  })
}
