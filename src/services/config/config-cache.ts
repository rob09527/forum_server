import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'

/**
 * 配置读取的**进程内缓存 + 跨实例失效**（交接快照 §11.7 技术点 1、2）。
 *
 * ## 为什么要缓存
 * 改动前 `config.service.ts` 每次调用都 `redis.get`，签到/发帖/限流等热路径每请求一次 Redis 往返。
 * 用户明确要求「内存加载」。加了缓存后，全局限流的 `max` 函数（每请求都要读 `config:limits`）
 * 才不至于把每个 HTTP 请求都变成一次 Redis 往返。
 *
 * ## 为什么「保存时清本进程缓存」不够 —— 必须跨进程
 * 生产 forum server 是多实例（deploy/docker-compose.yml，与 `bountySweepLock` 同样的多实例假设）。
 * 配置的唯一写入口是 forum 侧 `setConfig()`（admin 经 `/api/admin/config` 转发，不直连 Redis），
 * 但那个 PUT **只会被负载均衡打到其中一台**。只清本进程缓存 → 其余实例继续用旧值，
 * 表现为「后台改了、部分请求生效部分不生效」，且随负载均衡漂移，极难定位。
 *
 * ## 选定方案:Redis pub/sub 广播失效 + 软 TTL 兜底
 * - **pub/sub 是主通道**（即时，亚毫秒）：写入方 `PUBLISH config:invalidate <group>`，
 *   每个实例在启动时用**独立连接**订阅，收到即删对应缓存项，下次读取回源 Redis。
 *   多实例下为何成立：`PUBLISH` 由 Redis 服务端向**当前所有订阅者**扇出，与「哪台实例处理了写请求」无关；
 *   每个实例各自持有一条订阅连接，所以每台都会收到。
 * - **软 TTL 是兜底**（`CACHE_TTL_MS`）：Redis pub/sub 是 fire-and-forget，**不保证投递** ——
 *   订阅连接正在重连、实例刚启动还没订阅上、网络抖动，都会丢消息。
 *   给每个缓存项加软过期后，即使广播丢了，最坏也在 `CACHE_TTL_MS` 内收敛，不会永久卡在旧值。
 * - **重连即全清**：订阅连接每次 `ready`（含首连和断线重连）都清空整个缓存，
 *   保证「断线窗口内发生的变更」不会以旧值形式残留。
 *
 * 为什么不选「版本号 key + 短 TTL」：那个方案每次读配置仍要 `GET config:version`，
 * 等于把「每请求一次 Redis 往返」原样搬了回来，与「内存加载」的初衷相悖。
 *
 * ## 独立连接的必要性
 * ioredis 进入 subscriber 模式后该连接**不能再执行普通命令**，所以不能复用 `lib/redis.ts` 的全局实例。
 * 这里用 `redis.duplicate()`（继承同一份连接配置），而不是 `new Redis(...)` 另抄一遍 URL。
 */

/**
 * 缓存项软过期时间（毫秒）。
 * 只是 pub/sub 丢消息时的收敛上界，正常路径由广播即时失效，所以可以取得比较宽松。
 */
const CACHE_TTL_MS = 30_000

/** 正在进行的回源请求，按 Redis key 合并，避免失效瞬间重复 GET */
const inFlight = new Map<string, Promise<unknown>>()

/** 读取同一配置 key 的进行中请求 */
export function getInFlightConfig<T>(key: string): Promise<T> | undefined {
  return inFlight.get(key) as Promise<T> | undefined
}

/** 注册并合并同一配置 key 的回源请求 */
export function setInFlightConfig<T>(key: string, request: Promise<T>): Promise<T> {
  inFlight.set(key, request)
  request.finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key)
  }).catch(() => undefined)
  return request
}

/** 缓存项：已通过 zod 校验 + 默认兜底的**最终生效值** */
interface CacheEntry {
  /** 生效值（配置组的对象或数组） */
  value: unknown
  /** 软过期时间戳（epoch ms） */
  expiresAt: number
}

/** key = 配置组的 Redis key（如 `config:limits`） */
const cache = new Map<string, CacheEntry>()

/** 广播 message 为该值时表示「全部配置失效」 */
const INVALIDATE_ALL = '*'

/**
 * 读缓存。未命中或已软过期返回 `undefined`（配置组的值恒为对象/数组，不会与合法值混淆）。
 */
export function getCachedConfig<T>(key: string): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.value as T
}

/** 写缓存（存的是校验+兜底后的最终值，命中时可同时省掉 Redis 往返与 zod 解析） */
export function setCachedConfig(key: string, value: unknown): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

/**
 * 失效本进程缓存。
 * @param key 配置组的 Redis key；省略则清空全部
 */
export function invalidateCachedConfig(key?: string): void {
  if (key) cache.delete(key)
  else cache.clear()
}

/**
 * 广播「某组配置已变更」到所有 forum 实例（含本进程 —— 本进程另有同步失效，广播只是兜底）。
 * 失败只记日志：配置已经落 Redis 了，广播失败最坏退化为「等软 TTL 收敛」，不能因此让写接口报错。
 */
export async function publishConfigInvalidation(key: string): Promise<void> {
  try {
    await redis.publish(RedisKey.configInvalidateChannel, key)
  } catch (err) {
    console.warn(
      `[config] 失效广播失败（${key}），其它实例将在软 TTL 内收敛:`,
      (err as Error).message,
    )
  }
}

/** 订阅连接（模块级单例，避免热重载/重复调用时开出多条连接） */
let subscriber: ReturnType<typeof redis.duplicate> | null = null

/**
 * 启动失效订阅。**每个 forum 实例启动时调用一次**（见 app.ts）。
 * 幂等：重复调用不会再开连接。
 */
export function startConfigInvalidationSubscriber(): void {
  if (subscriber) return

  const sub = redis.duplicate()
  subscriber = sub

  // 断线重连窗口内的变更广播必然丢失，所以每次 ready（含首连）都整体清缓存，
  // 用一次回源换「绝不残留旧值」。
  sub.on('ready', () => {
    invalidateCachedConfig()
  })

  sub.on('error', (err: Error) => {
    // 不抛：订阅挂了只是退化为软 TTL 收敛，不能拖垮业务进程
    console.warn('[config] 失效订阅连接异常:', err.message)
  })

  sub.on('message', (_channel: string, message: string) => {
    if (!message || message === INVALIDATE_ALL) invalidateCachedConfig()
    else invalidateCachedConfig(message)
  })

  sub.subscribe(RedisKey.configInvalidateChannel).catch((err: Error) => {
    console.warn('[config] 订阅失效频道失败，配置更新将退化为软 TTL 收敛:', err.message)
  })
}
