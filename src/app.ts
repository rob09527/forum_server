import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'
import { ErrorCode } from './constants/error-codes.js'
import { authRoutes } from './routes/auth.routes.js'
import { categoryRoutes } from './routes/category.routes.js'
import { postRoutes } from './routes/post.routes.js'
import { commentRoutes } from './routes/comment.routes.js'
import { uploadRoutes } from './routes/upload.routes.js'
import { checkinRoutes } from './routes/checkin.routes.js'
import { userRoutes } from './routes/user.routes.js'
import { sendSuccess } from './utils/response.js'

export const fastify = Fastify({ logger: true })

// ── 框架层统一错误处理 ──
// 所有抛出的错误都在这里格式化为 { success: false, error: { code, message } }
// 使用 duck-typing 而非 instanceof，避免 ESM/tsx 下原型链断裂导致格式不统一
// 注意：必须在 register 之前注册。下面的 await register 会立即 boot 插件，
// 路由 context 在注册那一刻就快照了当时的 errorHandler，若在此之后再 setErrorHandler，
// 已注册的路由仍会用 Fastify 默认 handler，导致错误格式不统一。
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

// --- Plugins ---
await fastify.register(cors, {
  origin: ['http://localhost:3000'], // Nuxt dev server
  credentials: true,
})

await fastify.register(cookie)

// multipart 文件上传（解析限制 = 单文件上限 + 1MB 缓冲，略大于应用层校验以先兜住大文件）
await fastify.register(multipart, {
  limits: {
    fileSize: config.UPLOAD_MAX_FILE_SIZE + 1024 * 1024,
    files: 1,
  },
})

// 静态文件：server/public/uploads/ 下的图片
// URL /uploads/xxx → public/uploads/xxx，只暴露 uploads 目录不暴露 public 其他文件
await fastify.register(fastifyStatic, {
  root: path.resolve(process.cwd(), 'public', 'uploads'),
  prefix: '/uploads/',
  decorateReply: false,
})

// --- Routes ---
await fastify.register(authRoutes)
await fastify.register(categoryRoutes)
await fastify.register(postRoutes)
await fastify.register(commentRoutes)
await fastify.register(uploadRoutes)
await fastify.register(checkinRoutes)
await fastify.register(userRoutes)

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
