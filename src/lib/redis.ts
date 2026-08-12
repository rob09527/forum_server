import { Redis } from 'ioredis'
import { config } from '../config.js'

/**
 * 全局 Redis 客户端实例。
 * 所有模块共用这一个实例，不要各自 new Redis()。
 * 本地开发不设密码，生产通过 .env 注入。
 */
export const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
})

// 应用启动时连接 Redis（不阻塞模块加载）
redis.connect().catch((err: Error) => {
  console.error('Redis 连接失败:', err.message)
})

export { RedisKey } from '../constants/redis-keys.js'
