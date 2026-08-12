import 'dotenv/config'
import { z } from 'zod'

/**
 * 应用配置，从环境变量读取，zod 校验。
 * process.env.XXX 禁止在业务代码中直接使用——统一走这里。
 */

// [规范例外] 这里的 config 不拆分文件，因为 8 个配置项拆成多个
// 常量文件反而增加跳转成本，集中更易维护

const envSchema = z.object({
  /** 服务监听端口，默认 3001 */
  PORT: z.coerce.number().int().positive().default(3001),
  /** 监听地址，默认 0.0.0.0 */
  HOST: z.string().default('0.0.0.0'),
  /** PostgreSQL 连接字符串 */
  DATABASE_URL: z.string().min(1),
  /** Redis 连接字符串 */
  REDIS_URL: z.string().min(1),
  /** MeiliSearch 地址 */
  MEILI_HOST: z.string().min(1),
  /** MeiliSearch Master Key */
  MEILI_MASTER_KEY: z.string().default(''),
  /** Telegram Bot Token，用于 TG Login Widget 验签 */
  TELEGRAM_BOT_TOKEN: z.string().default(''),

  /** 单文件最大字节数，默认 10MB */
  UPLOAD_MAX_FILE_SIZE: z.coerce.number().int().positive().default(10485760),
  /** 单用户累计上传总字节数上限，默认 50MB */
  UPLOAD_MAX_USER_TOTAL_SIZE: z.coerce.number().int().positive().default(52428800),
  /** 单用户每分钟最大上传次数，默认 20 */
  UPLOAD_MAX_UPLOADS_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** 图片基础 URL，本地用当前 IP:3001，生产换域名；DB 只存相对路径，API 返回时拼接 */
  UPLOAD_BASE_URL: z.string().min(1).default('http://localhost:3001'),

  /** 帖子正文最少字符数，防止水帖，默认 10 */
  POST_MIN_CONTENT_LENGTH: z.coerce.number().int().positive().default(10),
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
