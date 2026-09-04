import { UPLOAD_URL_ROOT, UploadPartition } from '../../constants/upload-paths.js'

/**
 * 全局限流的**分桶**（交接快照 §13 决定 3 / §8.7 第 3 项）。
 *
 * ## 为什么必须分桶，而不是给 `/uploads/*` 加白名单
 * 用户的决定原话是「头像图片的获取频率也做成限制配置在后台，**和正常图片区分开来**」——
 * 要的是三条独立配额，不是把静态图放行。白名单等于把影子头像目录变成不限速的公开图床。
 *
 * ## 分桶落在 `keyGenerator`，不是只改 `max`（这是踩过的点）
 * `@fastify/rate-limit` 的计数是**按 `keyGenerator` 返回的 key 存一条**（见其 index.js:215 `store.incr(key,…)`）。
 * 只把 `max` 改成按路径取不同值、`keyGenerator` 仍返回 `req.ip`，三类请求会共用同一个计数器 ——
 * 那不是「三个桶」，而是「一个桶、阈值随请求类型跳变」：翻两页头像就能把 `/api/*` 的配额吃光，
 * 恰好复现 §8.7 第 3 项描述的「首页空列表 + 头像批量裂图」。
 * 所以 key 必须带桶名后缀，`max` 再按同一桶名取值，两者一致。
 *
 * ## 与 `constants/upload-paths.ts` 的关系
 * 分区名是那个文件的单一事实来源（它的第 3 条约束就写着「限流要分桶，见 config:limits」）。
 * 这里只做 URL → 桶名的映射，不再自己写 `'avatars'` 字面量。
 */

/** 限流桶标识。同时用作 Redis/LRU 计数 key 的后缀与 `config:limits` 的取值分支 */
export const RateBucket = {
  /** `/api/*` 及其它所有非静态请求（原先那条 600 次/分/IP 就是这个桶） */
  API: 'api',
  /** 头像静态图 `/uploads/avatars/*`：一屏几十张，单独一个高配额桶 */
  AVATAR: 'avatar',
  /** 其余上传静态图 `/uploads/*`（正文图/运营素材）：一屏几张，配额低得多 */
  IMAGE: 'image',
} as const

/** 桶标识的联合类型 */
export type RateBucketName = (typeof RateBucket)[keyof typeof RateBucket]

/** 上传静态资源的 URL 前缀，如 `/uploads/` */
const UPLOAD_PREFIX = `${UPLOAD_URL_ROOT}/`

/** 头像分区的 URL 前缀，如 `/uploads/avatars/` */
const AVATAR_PREFIX = `${UPLOAD_PREFIX}${UploadPartition.AVATARS}/`

/**
 * 按请求 URL 判定所属限流桶。
 *
 * @param url `request.url`，含 query string（内部会截掉）
 * @returns 桶标识
 *
 * 注意：含 `..` 的路径**一律不判为头像桶**。头像桶配额比图片桶高一个量级，
 * 若按裸前缀匹配，`/uploads/avatars/../posts/x.png` 就能用高配额去拉正文图（限流绕过）。
 * fastifyStatic 自己会规范化并拒绝越界，但 keyGenerator 拿到的是原始 URL，所以这里自己挡一次。
 */
export function resolveRateBucket(url: string): RateBucketName {
  const path = url.split('?')[0]
  if (!path.startsWith(UPLOAD_PREFIX)) return RateBucket.API
  if (path.includes('..')) return RateBucket.IMAGE
  return path.startsWith(AVATAR_PREFIX) ? RateBucket.AVATAR : RateBucket.IMAGE
}
