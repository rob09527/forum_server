import type { FastifyInstance } from 'fastify'
import { register, login, telegramAuth } from '../services/auth/auth.service.js'
import { revokeToken, SESSION_COOKIE, SESSION_TTL } from '../services/auth/auth-token.service.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { ValidationError } from '../utils/errors.js'
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
  fastify.post('/api/auth/register', async (request, reply) => {
    const { username, email, password } = request.body as {
      username: string
      email: string
      password: string
    }

    // 基础校验（Fastify JSON Schema 更好，但 MVP 先手写）
    if (!username || username.length < 3 || username.length > 20) {
      throw new ValidationError('用户名需要 3-20 个字符')
    }
    if (!email || !email.includes('@')) {
      throw new ValidationError('请输入有效的邮箱地址')
    }
    if (!password || password.length < 8) {
      throw new ValidationError('密码至少需要 8 个字符')
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
  fastify.post('/api/auth/login', async (request, reply) => {
    const { email, password } = request.body as {
      email: string
      password: string
    }

    if (!email || !password) {
      throw new ValidationError('请输入邮箱和密码')
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
  fastify.post('/api/auth/telegram', async (request, reply) => {
    const data = request.body as {
      id: number
      first_name: string
      last_name?: string
      username?: string
      photo_url?: string
      auth_date: number
      hash: string
    }

    if (!data.id || !data.hash) {
      throw new ValidationError('缺少 Telegram 授权数据')
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
