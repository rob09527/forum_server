import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { config } from './config.js'
import { ErrorCode } from './constants/error-codes.js'
import { authRoutes } from './routes/auth.routes.js'
import { sendSuccess } from './utils/response.js'

export const fastify = Fastify({ logger: true })

// --- Plugins ---
await fastify.register(cors, {
  origin: ['http://localhost:3000'], // Nuxt dev server
  credentials: true,
})

await fastify.register(cookie)

// --- Routes ---
await fastify.register(authRoutes)

// [规范例外] health check 和 /test-tg 的查询/读文件逻辑直接写在这里，
// 因为没有对应的 service，为 3 行逻辑新建 service 文件反而过度

// --- Health check ---
fastify.get('/api/health', async (_request, reply) => {
  sendSuccess(reply, { status: 'ok', timestamp: new Date().toISOString() })
})

// --- TG Login 测试页（仅开发环境使用） ---
fastify.get('/test-tg', async (_request, reply) => {
  const html = await readFile('../docs/scripts/test-tg-login.html', 'utf-8')
  reply.type('text/html').send(html)
})

// ── 框架层统一错误处理 ──
// 所有抛出的错误都在这里格式化为 { success: false, error: { code, message } }
// 使用 duck-typing 而非 instanceof，避免 ESM/tsx 下原型链断裂导致格式不统一
fastify.setErrorHandler((rawError, _request, reply) => {
  // 1. 业务错误 — 有 statusCode + code 的就是我们的 AppError 子类
  const appErr = rawError as { statusCode?: number; code?: string; message?: string }
  if (typeof appErr.statusCode === 'number' && typeof appErr.code === 'string') {
    return reply.status(appErr.statusCode).send({
      success: false,
      error: {
        code: appErr.code,
        message: appErr.message || '未知错误',
      },
    })
  }

  // 2. Fastify 内置的 validation error
  const fastifyErr = rawError as { validation?: unknown; statusCode?: number; message?: string }
  if (fastifyErr.validation) {
    return reply.status(400).send({
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: fastifyErr.message || '参数校验失败',
      },
    })
  }

  // 3. 未知错误 — 兜底，不暴露详情
  fastify.log.error(rawError)
  return reply.status(500).send({
    success: false,
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: '服务器内部错误',
    },
  })
})

// ── 404 统一格式 ──
fastify.setNotFoundHandler((_request, reply) => {
  return reply.status(404).send({
    success: false,
    error: {
      code: ErrorCode.NOT_FOUND,
      message: '接口不存在',
    },
  })
})
