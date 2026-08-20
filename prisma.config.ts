import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

/**
 * Prisma CLI 配置（仅用于 migrate / db push / studio 等命令行操作）。
 * 运行时的数据库连接通过 src/lib/prisma.ts 中的 adapter 处理。
 *
 * shadowDatabaseUrl（可选）：`migrate diff --from-migrations` / `migrate dev` 生成迁移
 * 时需要临时 shadow 库回放迁移历史（Prisma 自动创建+删除）。部署只用 `migrate deploy`，
 * 不需要它，故不设置时该键缺席。
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
})
