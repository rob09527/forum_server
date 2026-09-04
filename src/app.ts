import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import rateLimit from '@fastify/rate-limit'
import { config } from './config.js'
import { ErrorCode } from './constants/error-codes.js'
import { AppError } from './utils/errors.js'
import { validationMessage } from './utils/validation.js'
import { csrfGuard } from './plugins/csrf.js'
import { getLimitsConfig } from './services/config/config.service.js'
import { startConfigInvalidationSubscriber } from './services/config/config-cache.js'
import { RateBucket, resolveRateBucket } from './services/config/rate-buckets.js'
import { announcementRoutes } from './routes/announcement.routes.js'
import { advertRoutes } from './routes/advert.routes.js'
import { authRoutes } from './routes/auth.routes.js'
import { categoryRoutes } from './routes/category.routes.js'
import { postRoutes } from './routes/post.routes.js'
import { commentRoutes } from './routes/comment.routes.js'
import { uploadRoutes } from './routes/upload.routes.js'
import { checkinRoutes } from './routes/checkin.routes.js'
import { userRoutes } from './routes/user.routes.js'
import { adminRoutes } from './routes/admin.routes.js'
import { searchRoutes } from './routes/search.routes.js'
import { configRoutes } from './routes/config.routes.js'
import { notificationRoutes } from './routes/notification.routes.js'
import { realtimeRoutes } from './routes/realtime.routes.js'
import { messageRoutes } from './routes/message.routes.js'
import { bookmarkRoutes } from './routes/bookmark.routes.js'
import { followRoutes } from './routes/follow.routes.js'
import { shopRoutes } from './routes/shop.routes.js'
import { tipRoutes } from './routes/tip.routes.js'
import { bountyRoutes } from './routes/bounty.routes.js'
import { propsRoutes } from './routes/props.routes.js'
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

  // 2. Fastify 内置的 validation error（schema 校验失败）
  const fastifyErr = rawError as { validation?: unknown; statusCode?: number; message?: string }
  if (fastifyErr.validation) {
    return reply.status(400).send({
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: validationMessage(fastifyErr),
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

// 允许的浏览器源（CORS 与 CSRF 共用）；逗号分隔多域名，本地/测试/生产各自配置
const ALLOWED_ORIGINS = config.ALLOWED_ORIGINS.split(',').map((s) => s.trim())

// --- Plugins ---
await fastify.register(cors, {
  origin: ALLOWED_ORIGINS, // Nuxt dev server
  credentials: true,
})

// CSRF 纵深防御：写操作校验 Origin/Referer（SameSite=lax 之外的第二重防线）。
// 必须用 addHook 挂在 root 实例上，不能 register 成插件——插件会创建子上下文，钩子会被封装、作用不到全局路由。
fastify.addHook('onRequest', csrfGuard(ALLOWED_ORIGINS))

await fastify.register(cookie)

// 配置失效订阅：必须在任何配置读取之前启动，否则本实例收不到其它实例的变更广播（见 config-cache.ts）
startConfigInvalidationSubscriber()

/**
 * 全局限流：**按 IP + 桶** 计数，三个桶的阈值都存 `config:limits`（后台可改，改完即时生效）。
 * 认证端点（login/register/telegram）在路由内用 `config.rateLimit` 收紧到 5 次 —— 那些是
 * 路由级覆盖，插件会给它们单独开 `store.child()`，与这里的全局 key 互不干扰。
 *
 * ⚠️ 两个必须成对出现的点：
 * 1. `max` **必须写函数形式**。写成常量（原先的 `max: 600`）时，插件只在注册那一刻读一次值，
 *    后台改了配置也永远不生效。函数形式则每请求求值一次（@fastify/rate-limit 10.x 支持 async）。
 * 2. `keyGenerator` **必须带桶名后缀**。插件的计数是按 keyGenerator 返回的 key 存一条，
 *    只改 `max` 不改 key，三类请求仍共用同一个计数器 —— 那是「一个桶、阈值乱跳」，
 *    翻两页头像就把 `/api/*` 的配额吃光，正是 §8.7 第 3 项那个「首页空列表 + 头像批量裂图」。
 *
 * `cache` 从默认 5000 提到 15000：每 IP 现在最多占 3 个 key，不提的话可容纳的独立 IP 数会掉到 1/3
 * （LRU 淘汰的后果是计数被重置、限流失效，属于 fail-open，但仍应避免）。
 */
await fastify.register(rateLimit, {
  global: true,
  timeWindow: '1 minute',
  cache: 15_000,
  keyGenerator: (request) => `${request.ip}:${resolveRateBucket(request.url)}`,
  max: async (request) => {
    const limits = await getLimitsConfig()
    switch (resolveRateBucket(request.url)) {
      case RateBucket.AVATAR:
        return limits.avatarFetchPerMinute
      case RateBucket.IMAGE:
        return limits.imageFetchPerMinute
      default:
        return limits.apiRatePerMinute
    }
  },
  // errorResponseBuilder 必须「throw」一个带 statusCode + code 的错误对象，
  // 走全局 errorHandler 的 AppError 分支统一格式化（若返回 body 会被当 500 处理）。
  errorResponseBuilder: (_request, _context) =>
    new AppError('请求过于频繁，请稍后再试', 429, ErrorCode.RATE_LIMITED),
})

// multipart 文件上传（解析限制 = 单文件上限 + 1MB 缓冲，略大于应用层校验以先兜住大文件）
//
// ⚠️ 这里只能在启动时读一次：@fastify/multipart 的 limits 由 busboy 在注册时接管，不支持函数形式。
// 后果是**「调小」即时生效**（应用层 upload.service 校验按当前配置走），
// 而**「调大」超过启动时的值需要重启 forum**（解析器会先把请求截断）。
// 没有把这里放宽到 schema 上界（100MB），是因为那等于把内存 DoS 面永久开到最大。
const bootLimits = await getLimitsConfig()
await fastify.register(multipart, {
  limits: {
    fileSize: bootLimits.uploadMaxFileSize + 1024 * 1024,
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
await fastify.register(announcementRoutes)
await fastify.register(advertRoutes)
await fastify.register(authRoutes)
await fastify.register(categoryRoutes)
await fastify.register(postRoutes)
await fastify.register(commentRoutes)
await fastify.register(uploadRoutes)
await fastify.register(checkinRoutes)
await fastify.register(userRoutes)
await fastify.register(adminRoutes)
await fastify.register(searchRoutes)
await fastify.register(configRoutes)
await fastify.register(notificationRoutes)
await fastify.register(realtimeRoutes)
await fastify.register(messageRoutes)
await fastify.register(bookmarkRoutes)
await fastify.register(followRoutes)
await fastify.register(shopRoutes)
await fastify.register(tipRoutes)
await fastify.register(bountyRoutes)
await fastify.register(propsRoutes)

// [规范例外] health check 和 /test-tg 的查询/读文件逻辑直接写在这里，
// 因为没有对应的 service，为 3 行逻辑新建 service 文件反而过度

// --- Health check ---
fastify.get('/api/health', async (_request, reply) => {
  sendSuccess(reply, { status: 'ok', timestamp: new Date().toISOString() })
})

// --- TG Login 测试页（仅非生产环境使用，生产不暴露含 ngrok 地址的调试页） ---
if (config.NODE_ENV !== 'production') {
  fastify.get('/test-tg', async (_request, reply) => {
    const html = await readFile('../docs/scripts/test-tg-login.html', 'utf-8')
    reply.type('text/html').send(html)
  })
}
