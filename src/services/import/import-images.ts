import { mkdir, writeFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'
import { fetchNodelocBinary } from './nodeloc-client.js'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_CACHE_ENTRIES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_PROCESSING_CONCURRENCY,
  IMPORT_UPLOAD_SUBDIR,
  NODELOC_BASE_URL,
} from './import-config.js'
import { UPLOAD_URL_ROOT } from '../../constants/upload-paths.js'
import type { DiscoursePost } from './nodeloc-types.js'
import type { CleanContext, Sha1ImageSources } from './clean-markdown.js'
import {
  extractUploadTokens,
  extractRemoteUploadUrls,
  buildRemoteUrlMap,
  buildSha1UrlMap,
  parseUploadSha1,
} from './clean-markdown.js'

/**
 * 导入图片管道:把 NodeLoc 帖内图片(upload:// 伪协议 + uploads 直链)下载落盘,
 * 产出 clean-markdown 需要的 URL 重写映射。
 *
 * [合理例外] 绕开 /api/upload 上传服务(saveImage):
 * 该服务带 50MB/用户总量与 20 次/分限流,是给真实用户设计的;
 * 导入器数万张图会立即打爆限额。故直接写 public/uploads/nodeloc/,
 * 且不计入影子用户 uploadSize(导入内容不占用户配额语义)。
 * 落库一律相对路径 /uploads/nodeloc/...,由 UPLOAD_BASE_URL 在 API 层拼接(迁移不裂图)。
 *
 * 分区:根段取 `constants/upload-paths.ts` 的 `UPLOAD_URL_ROOT`,子目录取 import-config 的
 * `IMPORT_UPLOAD_SUBDIR` / `IMPORT_AVATAR_SUBDIR`(过渡期仍是 nodeloc,改名归收尾流水线第 1 步,
 * 见那两个常量的注释)。本文件**不再出现 `/uploads` 字面量**,改名只需动 import-config 一处。
 * 规范全文见 docs/图片分区规范.md。
 */

/** 图片存储根目录(server/public/uploads,与 upload.service 同根) */
const UPLOAD_DIR = path.resolve(process.cwd(), 'public', 'uploads')

/**
 * 拼落库用的相对路径。
 * 不直接用 upload-paths 的 `uploadRelativePath()`:那个函数的入参类型是 `UploadPartitionName`
 * (只接受已定义的四个分区),而导入侧过渡期的子目录是 `nodeloc` / `nodeloc/avatars`
 * —— 还不在分区枚举里,硬塞进去要靠强制类型转换。改名后两者会合流,可换回那个函数。
 *
 * @param subdir 分区/子目录段(如 `nodeloc`、`nodeloc/avatars`)
 * @param filename 文件名(含扩展名)
 * @returns 形如 `/uploads/nodeloc/abc.png`
 */
function importRelativePath(subdir: string, filename: string): string {
  if (!/^(?:[a-z0-9]+)(?:\/[a-z0-9]+)*$/.test(subdir) || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
    throw new Error(`[import] 非法图片分区路径: ${subdir}/${filename}`)
  }
  return `${UPLOAD_URL_ROOT}/${subdir}/${filename}`
}

/** 进程内已落盘文件缓存(token/URL hash → 相对路径),避免重复下载与重复 stat */
const savedCache = new Map<string, string>()
/** 同一 key 的进行中任务，避免并发重复下载；完成后从这里移除。 */
const inFlightCache = new Map<string, Promise<string | null>>()
let activeImageProcessing = 0
const imageProcessingWaiters: Array<() => void> = []

async function withImageProcessingLimit<T>(task: () => Promise<T>): Promise<T> {
  if (activeImageProcessing >= MAX_IMAGE_PROCESSING_CONCURRENCY) {
    await new Promise<void>((resolve) => imageProcessingWaiters.push(resolve))
  }
  activeImageProcessing += 1
  try {
    return await task()
  } finally {
    activeImageProcessing -= 1
    imageProcessingWaiters.shift()?.()
  }
}

function cacheSavedPath(key: string, relativePath: string): void {
  if (savedCache.has(key)) savedCache.delete(key)
  savedCache.set(key, relativePath)
  while (savedCache.size > MAX_IMAGE_CACHE_ENTRIES) {
    const oldest = savedCache.keys().next().value
    if (oldest === undefined) break
    savedCache.delete(oldest)
  }
}


/** 允许落盘的图片扩展名；SVG 不允许进入同源 uploads，避免主动内容被当作静态资源托管。 */
const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'])

/** 从 URL/contentType 推断扩展名,不认识返回 null(跳过下载) */
function inferExt(url: string, contentType: string): string | null {
  const fromUrl = /\.([a-zA-Z0-9]+)(?:[?#]|$)/.exec(url)?.[1]?.toLowerCase()
  if (fromUrl && ALLOWED_EXTS.has(fromUrl)) return fromUrl === 'jpg' ? 'jpeg' : fromUrl
  const fromType = /image\/([a-z0-9+]+)/.exec(contentType)?.[1]
  if (fromType && ALLOWED_EXTS.has(fromType)) return fromType
  return null
}

/**
 * 下载一张远程图并落盘,返回相对路径;失败/超限/非图返回 null。
 * 文件名 = 稳定标识(base62 token 或 URL sha1 前 16 位)+ 扩展名 → 天然去重,重跑幂等。
 */
async function downloadOne(remoteUrl: string, stableKey: string): Promise<string | null> {
  const cached = savedCache.get(stableKey)
  if (cached) return cached
  const inFlight = inFlightCache.get(stableKey)
  if (inFlight) return inFlight
  const task = withImageProcessingLimit(async () => downloadOneUncached(remoteUrl, stableKey))
  inFlightCache.set(stableKey, task)
  try {
    return await task
  } finally {
    inFlightCache.delete(stableKey)
  }
}

async function downloadOneUncached(remoteUrl: string, stableKey: string): Promise<string | null> {
  // 幂等:已存在同 key 文件直接复用(按候选扩展名探测)
  for (const ext of ALLOWED_EXTS) {
    const rel = importRelativePath(IMPORT_UPLOAD_SUBDIR, `${stableKey}.${ext}`)
    try {
      await access(path.join(UPLOAD_DIR, IMPORT_UPLOAD_SUBDIR, `${stableKey}.${ext}`))
      cacheSavedPath(stableKey, rel)
      return rel
    } catch {
      /* 不存在,继续 */
    }
  }

  const result = await fetchNodelocBinary(remoteUrl, MAX_IMAGE_BYTES)
  if (!result) return null
  const ext = inferExt(remoteUrl, result.contentType)
  if (!ext) return null
  try {
    const metadata = await sharp(result.data, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata()
    if (
      !metadata.format ||
      !['jpeg', 'png', 'gif', 'webp', 'avif'].includes(metadata.format) ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_IMAGE_DIMENSION ||
      metadata.height > MAX_IMAGE_DIMENSION
    ) return null
  } catch {
    return null
  }

  const relativePath = importRelativePath(IMPORT_UPLOAD_SUBDIR, `${stableKey}.${ext}`)
  const filePath = path.join(UPLOAD_DIR, IMPORT_UPLOAD_SUBDIR, `${stableKey}.${ext}`)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, result.data)
  cacheSavedPath(stableKey, relativePath)
  return relativePath
}

/**
 * 下载正文里的 nodeloc uploads 直链,返回本地相对路径。
 *
 * 正文直链是 `/uploads/default/{sha1}` 这种无分片路径形态,**源站直接 404**
 * (2026-09-03 抽查 3/3 全 404)。所以必须先用 cooked 反解出的 sha1 → 真实地址表换址,
 * 换址候选按「原图 → 压缩图」顺序试(原图画质优先;原图超 MAX_IMAGE_BYTES 时
 * downloadOne 返回 null,自动降级到压缩图),都拿不到才回退直连原链。
 *
 * @param remoteUrl 正文里出现的原始 URL(是 localUrlByRemote 的 key,调用方据此做字符串替换,不可改写)
 * @param srcBySha1 全主题 cooked 反解出的 sha1 → 真实地址表
 * @param topicId 仅用于失败日志定位
 * @returns 本地相对路径;彻底失败返回 null 并打 warn(此时坏链会原样留在正文)
 */
export async function downloadUploadUrl(
  remoteUrl: string,
  srcBySha1: Map<string, Sha1ImageSources>,
  topicId: number | undefined,
): Promise<string | null> {
  const sha1 = parseUploadSha1(remoteUrl)
  const sources = sha1 ? srcBySha1.get(sha1) : undefined
  const candidates = [sources?.original, sources?.optimized].filter(
    (u): u is string => typeof u === 'string',
  )

  // 稳定 key 优先用图片内容 sha1 前 16 位:同图的 original/optimized 共用一份落盘,重跑幂等;
  // 反解不出 sha1 时退回「URL 的 sha1」(旧口径)
  const stableKey = sha1
    ? sha1.slice(0, 16)
    : createHash('sha1').update(remoteUrl).digest('hex').slice(0, 16)

  for (const candidate of candidates) {
    const absolute = candidate.startsWith('http') ? candidate : NODELOC_BASE_URL + candidate
    const local = await downloadOne(absolute, stableKey)
    if (local) return local
  }

  // 回退直连:cooked 里没有同 sha1 的图,或换址候选全部失败
  const local = await downloadOne(remoteUrl, stableKey)
  if (local) return local

  // 这里必须出声:此前静默返回 null 正是「40% 正文图片是死链」藏了这么久的原因
  console.warn(
    `[import] 正文图片下载失败,坏链将留在正文 | topic=${topicId ?? '?'} | url=${remoteUrl} | ` +
      (candidates.length ? `已试换址候选 ${candidates.length} 个` : 'cooked 里无同 sha1 图片'),
  )
  return null
}

/**
 * 处理一个主题全部楼层的图片,构建清洗上下文。
 * - upload://token → 借各楼 cooked 的 data-base62-sha1 解析真实 URL → 下载 → 本地相对路径
 *   (cooked 里找不到映射或下载失败 → 兜底 NodeLoc 原站绝对 URL,不裂图)
 * - 正文里的 nodeloc uploads 直链 → 经 sha1 换址后下载 → 本地相对路径(见 downloadUploadUrl)
 * - 外链图床(非 nodeloc 域)不动,原样保留
 */
/** 一个主题全部楼层 cooked 反解出的两套图片映射 */
export interface TopicImageMaps {
  /** upload:// base62 token → cooked 里的真实地址(依赖 data-base62-sha1 属性) */
  remoteByToken: Map<string, string>
  /** 图片 sha1 → 真实地址(不依赖任何属性,覆盖无 token 的 <img>) */
  srcBySha1: Map<string, Sha1ImageSources>
}

/**
 * 汇总一个主题全部楼层 cooked 的两套图片映射(跨楼层合并,引用图常出现在多楼)。
 * 单独导出是为了让回修脚本(repair-image-urls.ts)复用同一套反解口径,
 * 避免「导入器换址逻辑」与「回修脚本换址逻辑」两处实现漂移。
 */
export function buildTopicImageMaps(posts: DiscoursePost[]): TopicImageMaps {
  const remoteByToken = new Map<string, string>()
  const srcBySha1 = new Map<string, Sha1ImageSources>()
  for (const post of posts) {
    const cooked = post.cooked ?? ''
    for (const [token, url] of buildRemoteUrlMap(cooked)) {
      if (!remoteByToken.has(token)) remoteByToken.set(token, url)
    }
    for (const [sha1, sources] of buildSha1UrlMap(cooked)) {
      const entry = srcBySha1.get(sha1)
      if (!entry) srcBySha1.set(sha1, { ...sources })
      else {
        entry.original ??= sources.original
        entry.optimized ??= sources.optimized
      }
    }
  }
  return { remoteByToken, srcBySha1 }
}

export async function resolveTopicImages(posts: DiscoursePost[]): Promise<CleanContext> {
  // 1. 汇总全主题的两套映射
  const { remoteByToken, srcBySha1 } = buildTopicImageMaps(posts)

  const ctx: CleanContext = { uploadUrlByToken: new Map(), localUrlByRemote: new Map() }
  const topicId = posts[0]?.topic_id

  for (const post of posts) {
    const raw = post.raw ?? ''

    // 2. upload:// token:解析 → 下载 → 本地路径;失败兜底远程绝对 URL
    //
    // ⚠️ 这里必须走 downloadUploadUrl 而不是 downloadOne:
    // token 映射来自 cooked 属性,历史上出过「映射到 data-download-href 裸 sha1 地址」的错(见
    // buildRemoteUrlMap 注释)。downloadUploadUrl 会先按 sha1 换址再下载,即使映射给的是 404
    // 形态也能救回来;而且它下载失败会打 warn —— 旧的 downloadOne 路径是**静默**的,
    // 失败就把 404 地址当兜底写进正文,这正是死链一直没暴露的原因。
    for (const token of extractUploadTokens(raw)) {
      if (ctx.uploadUrlByToken.has(token)) continue
      const remote = remoteByToken.get(token)
      if (!remote) continue // 无法解析,clean 侧会给 404 占位地址
      const absolute = remote.startsWith('http') ? remote : NODELOC_BASE_URL + remote
      const local = await downloadUploadUrl(absolute, srcBySha1, topicId)
      ctx.uploadUrlByToken.set(token, local ?? absolute)
    }

    // 3. nodeloc uploads 直链:裸 sha1 形态源站 404,必须经 cooked 换址
    for (const remote of extractRemoteUploadUrls(raw)) {
      if (ctx.localUrlByRemote.has(remote)) continue
      const local = await downloadUploadUrl(remote, srcBySha1, topicId)
      if (local) ctx.localUrlByRemote.set(remote, local)
    }
  }

  return ctx
}

/**
 * 下载影子用户头像(avatar_template 的 {size} 换 288)并落盘。
 * @returns 相对路径 /uploads/nodeloc/avatars/u{sourceUserId}.ext;失败返回 null(调用方兜底 DiceBear)
 */
export async function downloadAvatar(
  avatarTemplate: string,
  sourceUserId: number,
  subdir: string,
): Promise<string | null> {
  const url = avatarTemplate.replace('{size}', '288')
  const absolute = url.startsWith('http') ? url : NODELOC_BASE_URL + url
  const result = await fetchNodelocBinary(absolute, MAX_IMAGE_BYTES)
  if (!result) return null
  const ext = inferExt(absolute, result.contentType)
  if (!ext) return null
  try {
    const metadata = await sharp(result.data, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata()
    if (
      !metadata.format ||
      !['jpeg', 'png', 'gif', 'webp', 'avif'].includes(metadata.format) ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_IMAGE_DIMENSION ||
      metadata.height > MAX_IMAGE_DIMENSION
    ) return null
  } catch {
    return null
  }
  const relativePath = importRelativePath(subdir, `u${sourceUserId}.${ext}`)
  const filePath = path.join(UPLOAD_DIR, subdir, `u${sourceUserId}.${ext}`)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, result.data)
  return relativePath
}
