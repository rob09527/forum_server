import { randomUUID } from 'crypto'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'

/** Session cookie 名称，auth 模块共用 */
export const SESSION_COOKIE = 'token'

/** 会话 TTL，单位秒（7 天） */
export const SESSION_TTL = 604800

/**
 * 认证 Token 服务。
 * 负责 session token 的生成、验证、销毁。
 * Token 本身是随机字符串（非 JWT），用户信息通过 Redis 查找。
 */

/** 生成 session token，存入 Redis 并返回 */
export async function generateToken(userId: number): Promise<string> {
  const token = randomUUID()
  await redis.setex(RedisKey.session(token), SESSION_TTL, String(userId))
  // 反向索引：记录该用户的所有 session，供封禁时批量下线。
  // 刷新整个 Set 的 TTL，避免 session 到期后死 token 永久残留导致集合无限膨胀；
  // 活跃用户 Set 内残留的少量死 token 有界，可接受。
  await redis.sadd(RedisKey.userSessions(userId), token)
  await redis.expire(RedisKey.userSessions(userId), SESSION_TTL)
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
  const userId = await redis.get(RedisKey.session(token))
  if (userId) {
    await redis.srem(RedisKey.userSessions(Number(userId)), token)
  }
  await redis.del(RedisKey.session(token))
}

/** 销毁某用户的全部 session（封禁/强制下线用） */
export async function revokeAllUserSessions(userId: number): Promise<void> {
  const key = RedisKey.userSessions(userId)
  const tokens = await redis.smembers(key)
  if (tokens.length > 0) {
    await redis.del(...tokens.map((t) => RedisKey.session(t)))
  }
  await redis.del(key)
}
