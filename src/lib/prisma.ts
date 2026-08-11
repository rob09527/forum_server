import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { config } from '../config.js'

/**
 * 全局 PrismaClient 实例。
 * 使用 Prisma 7 的 driver adapter 方式连接 PostgreSQL。
 * 所有 service 层引入这一个实例，不要各自 new PrismaClient()。
 */
const adapter = new PrismaPg({ connectionString: config.DATABASE_URL })

export const prisma = new PrismaClient({ adapter })
