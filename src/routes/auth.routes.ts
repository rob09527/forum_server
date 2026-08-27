import type { FastifyInstance } from 'fastify'
import { register, login, telegramAuth } from '../services/auth/auth.service.js'
import { revokeToken, SESSION_COOKIE, SESSION_TTL } from '../services/auth/auth-token.service.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { sendSuccess } from '../utils/response.js'

/**
 * 认证相关路由。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 * 所有响应通过 sendSuccess() 或 throw AppError 统一格式。
 */
export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/auth/register
   * 邮箱注册，返回用户信息和 session token
   */
  fastify.post('/api/auth/register', {
    config: { rateLimit: { max: 100000, timeWindow: '1 minute' } }, // TODO-ROLLBACK: 造数临时放大,完成后改回 max:5
    schema: {
      body: {
        type: 'object',
        required: ['username', 'email', 'password'],
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 20 },
          email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+$' },
          password: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const { username, email, password } = request.body as {
      username: string
      email: string
      password: string
    }

    const result = await register({ username, email, password })

    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      maxAge: SESSION_TTL, // 7 天
    })

    sendSuccess(reply, result, 201)
  })

  /**
   * POST /api/auth/login
   * 邮箱登录
   */
  fastify.post('/api/auth/login', {
    config: { rateLimit: { max: 100000, timeWindow: '1 minute' } }, // TODO-ROLLBACK: 造数临时放大,完成后改回 max:5
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body as {
      email: string
      password: string
    }

    const result = await login({ email, password })

    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      maxAge: SESSION_TTL,
    })

    sendSuccess(reply, result)
  })

  /**
   * POST /api/auth/telegram
   * TG 登录/注册（合一），验签后自动处理
   */
  fastify.post('/api/auth/telegram', {
    config: { rateLimit: { max: 100000, timeWindow: '1 minute' } }, // TODO-ROLLBACK: 造数临时放大,完成后改回 max:5
    schema: {
      body: {
        type: 'object',
        required: ['id', 'hash'],
        properties: {
          id: { type: 'integer' },
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          username: { type: 'string' },
          photo_url: { type: 'string' },
          auth_date: { type: 'integer' },
          hash: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const data = request.body as {
      id: number
      first_name: string
      last_name?: string
      username?: string
      photo_url?: string
      auth_date: number
      hash: string
    }

    const result = await telegramAuth(data)

    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      maxAge: SESSION_TTL,
    })

    sendSuccess(reply, result)
  })

  /**
   * POST /api/auth/logout
   * 退出登录，清除 cookie 和 Redis session
   */
  fastify.post('/api/auth/logout', { preHandler: [authenticate] }, async (request, reply) => {
    if (request.token) {
      await revokeToken(request.token)
    }

    reply.clearCookie(SESSION_COOKIE, { path: '/' })

    sendSuccess(reply, null)
  })

  /**
   * GET /api/auth/me
   * 获取当前登录用户信息
   */
  fastify.get('/api/auth/me', { preHandler: [authenticate] }, async (request, reply) => {
    // middleware 已挂载 user，直接返回即可
    sendSuccess(reply, { user: request.user })
  })
}
