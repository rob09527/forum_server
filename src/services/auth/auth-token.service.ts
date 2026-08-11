import { randomUUID } from 'crypto'
import { Redis } from 'ioredis'
import { config } from '../../config.js'
import { RedisKey } from '../../constants/redis-keys.js'

/** Session cookie 名称，auth 模块共用 */
export const SESSION_COOKIE = 'token'

/** 会话 TTL，单位秒（7 天） */
export const SESSION_TTL = 604800

/** Redis 客户端实例 */
const redis = new Redis(config.REDIS_URL, {
  // 本地开发不设密码，生产通过 .env 注入
  lazyConnect: true,
})

// 应用启动时连接 Redis（不阻塞模块加载）
redis.connect().catch((err: Error) => {
  console.error('Redis 连接失败:', err.message)
})

/**
 * 认证 Token 服务。
 * 负责 session token 的生成、验证、销毁。
 * Token 本身是随机字符串（非 JWT），用户信息通过 Redis 查找。
 */

/** 生成 session token，存入 Redis 并返回 */
export async function generateToken(userId: number): Promise<string> {
  const token = randomUUID()
  await redis.setex(RedisKey.session(token), SESSION_TTL, String(userId))
  return token
}

/**
 * 验证 token 并返回 userId。
 * 验证通过同时刷新 TTL（滑动续期）。
 * 返回 null 表示 token 无效或已过期。
 */
export async function verifyToken(token: string): Promise<number | null> {
  const key = RedisKey.session(token)
  const userId = await redis.get(key)
  if (!userId) return null
  // 滑动续期
  await redis.expire(key, SESSION_TTL)
  return Number(userId)
}

/** 销毁 token（退出登录） */
export async function revokeToken(token: string): Promise<void> {
  await redis.del(RedisKey.session(token))
}

export { redis }
