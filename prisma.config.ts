import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

/**
 * Prisma CLI 配置（仅用于 migrate / db push / studio 等命令行操作）。
 * 运行时的数据库连接通过 src/lib/prisma.ts 中的 adapter 处理。
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
})
