import 'dotenv/config'
import { z } from 'zod'

/**
 * 应用配置，从环境变量读取，zod 校验。
 * process.env.XXX 禁止在业务代码中直接使用——统一走这里。
 */

// [规范例外] 这里的 config 不拆分文件，因为 8 个配置项拆成多个
// 常量文件反而增加跳转成本，集中更易维护

const envSchema = z.object({
  /** 运行环境：development | production（区分测试页等开发专用逻辑） */
  NODE_ENV: z.string().default('development'),
  /** 服务监听端口，默认 3001 */
  PORT: z.coerce.number().int().positive().default(3001),
  /** 监听地址，默认 0.0.0.0 */
  HOST: z.string().default('0.0.0.0'),
  /** PostgreSQL 连接字符串 */
  DATABASE_URL: z.string().min(1),
  /** Redis 连接字符串 */
  REDIS_URL: z.string().min(1),
  /** Telegram Bot Token，用于 TG Login Widget 验签 */
  TELEGRAM_BOT_TOKEN: z.string().default(''),

  /** 管理后台服务间密钥，admin 后端调用 /api/admin/* 时在 X-Admin-Key 头携带 */
  FORUM_ADMIN_KEY: z.string().min(1),

  /**
   * 允许的浏览器源（CORS 与 CSRF 共用白名单），逗号分隔多域名。
   * 本地 http://localhost:3000；测试/生产填真实前端域名。
   */
  ALLOWED_ORIGINS: z.string().min(1),

  /** 单文件最大字节数，默认 10MB */
  UPLOAD_MAX_FILE_SIZE: z.coerce.number().int().positive().default(10485760),
  /** 单用户累计上传总字节数上限，默认 50MB */
  UPLOAD_MAX_USER_TOTAL_SIZE: z.coerce.number().int().positive().default(52428800),
  /** 单用户每分钟最大上传次数，默认 20 */
  UPLOAD_MAX_UPLOADS_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /**
   * 图片基础 URL，DB 只存相对路径、API 返回时拼接。
   * 必填无默认：生产漏配即启动失败，避免静默用 localhost 导致图片全失效。
   */
  UPLOAD_BASE_URL: z.string().min(1),

  /** 帖子正文最少字符数，防止水帖，默认 10 */
  POST_MIN_CONTENT_LENGTH: z.coerce.number().int().positive().default(10),

  /**
   * NodeLoc 数据同步 worker 开关，默认关闭。
   * true = 启用 worker：冷启动自动完成「全量回灌 → 造数 → 切增量」三阶段，
   * 之后进入 /posts.json 增量轮询，无需任何手工回填/造数前置步骤。
   */
  IMPORT_SYNC_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // ── 搜索（Meilisearch） ──
  /** Meilisearch 地址，本地 dev 用 Homebrew 原生实例，生产填 compose 内服务名 */
  MEILI_HOST: z.string().default('http://localhost:7700'),
  /** Meilisearch master key；本地 dev 无 key 留空，生产必填（compose 注入） */
  MEILI_MASTER_KEY: z.string().default(''),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ 配置校验失败:')
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const config = parsed.data
