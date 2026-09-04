import { mkdir, unlink, rmdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nanoid } from 'nanoid'
import sharp from 'sharp'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { AppError } from '../../utils/errors.js'
import { getLimitsConfig } from '../config/config.service.js'
import {
  UPLOAD_URL_ROOT,
  UploadPartition,
  uploadRelativePath,
} from '../../constants/upload-paths.js'

/**
 * 图片上传服务。
 * 核心约定：
 * - DB 只存相对路径（/uploads/posts/20260904/abc.webp），不存完整 URL
 * - API 返回时由 UPLOAD_BASE_URL 拼接完整 URL
 * - GIF 原样保留（表情包动效不丢），其他格式 sharp 转 WebP + strip EXIF
 * - 单文件大小 / 用户总量 / 每分钟次数由 config:limits 运行时控制（环境变量只提供默认值）
 * - 落盘分区取自 `constants/upload-paths.ts`（唯一事实来源），本文件不再自己写分区字面量
 *
 * ⚠️ 向后兼容（硬要求）：2026-09-04 之前上传的图片落在**分区之前的旧形态**
 * `/uploads/{YYYYMMDD}/`（库里实际存在 20260812/20260814/20260818/20260901 四个日期目录）。
 * 新图改落 `/uploads/posts/{YYYYMMDD}/` 之后，旧路径必须继续可读、可清理：
 * - 可读：静态目录挂在 `/uploads/` 前缀上（app.ts），与分区无关，旧路径原样命中；
 * - 可清理：`extractImagePaths` / `cleanPostImages` 都只认「`/uploads/` 打头 + 目录层级任意」，
 *   不对分区名做任何断言，见各自注释。**改这两个函数时不要引入分区白名单**，
 *   否则旧日期目录的孤儿文件会永远删不掉（磁盘只增不减）。
 */

/** 图片存储根目录（server/public/uploads） */
const UPLOAD_DIR = path.resolve(process.cwd(), 'public', 'uploads')

/** 待确认头像在 Redis 中的保留时间，超过后上传文件由清理任务回收。 */
const PENDING_AVATAR_TTL_SEC = 15 * 60

/** 记录待确认头像；头像上传阶段不计入用户最终配额。 */
async function registerPendingAvatar(relativePath: string, userId: number, size: number): Promise<void> {
  const key = RedisKey.pendingAvatar(relativePath)
  // marker 与索引必须同一原子脚本写入，避免进程在两条命令之间退出后资源永远不可 sweep。
  const script =
    "redis.call('set',KEYS[1],ARGV[1],'EX',ARGV[2]); " +
    "redis.call('sadd',KEYS[2],ARGV[3]); return 1"
  await redis.eval(
    script,
    2,
    key,
    RedisKey.pendingAvatarIndex,
    `${userId}:${size}`,
    String(PENDING_AVATAR_TTL_SEC),
    relativePath,
  )
}

/** 原子消费待确认头像，返回上传时字节数；非归属用户或已消费时返回 null。 */
export async function consumePendingAvatar(relativePath: string, userId: number): Promise<number | null> {
  const key = RedisKey.pendingAvatar(relativePath)
  const script =
    "local v=redis.call('get',KEYS[1]); if not v then return false end; " +
    "local prefix=ARGV[1]..':' ; if string.sub(v,1,string.len(prefix)) ~= prefix then return false end; " +
    "if string.sub(v,-11) == ':processing' then return false end; " +
    // 保留 processing 标记，避免确认事务尚未提交时 sweep 误删文件，也阻止重复确认重复计费。
    "redis.call('set',KEYS[1],v..':processing','EX',300); return string.sub(v,string.len(prefix)+1,string.len(v))"
  const result = await redis.eval(script, 1, key, String(userId))
  if (result === false || result === null) return null
  const size = Number(result)
  if (!Number.isSafeInteger(size) || size < 0) return null
  return size
}

/** 确认事务提交后删除 processing 标记；只删除仍属于该次确认的标记。 */
export async function finalizePendingAvatar(
  relativePath: string,
  userId: number,
  size: number,
): Promise<void> {
  const key = RedisKey.pendingAvatar(relativePath)
  const expected = `${userId}:${size}:processing`
  const script =
    "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end"
  const deleted = await redis.eval(script, 1, key, expected)
  if (Number(deleted) === 1) await redis.srem(RedisKey.pendingAvatarIndex, relativePath)
}

/** 确认失败时恢复待确认标记；仅恢复仍属于本次确认的 processing 值，避免复活新生命周期。 */
export async function restorePendingAvatar(relativePath: string, userId: number, size: number): Promise<void> {
  const key = RedisKey.pendingAvatar(relativePath)
  const expected = `${userId}:${size}:processing`
  const script =
    "if redis.call('get',KEYS[1]) ~= ARGV[1] then return 0 end; " +
    "redis.call('set',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1"
  const restored = await redis.eval(script, 1, key, expected, `${userId}:${size}`, String(PENDING_AVATAR_TTL_SEC))
  if (Number(restored) === 1) await redis.sadd(RedisKey.pendingAvatarIndex, relativePath)
}

/**
 * 清理待确认头像：索引是有界的业务集合，逐项原子认领过期资源后删除磁盘文件。
 * 不能用「先 TTL 再 unlink」：确认请求可能在 TTL 读取后把值改成 processing，导致 sweep 误删正在确认的文件。
 */
export async function sweepPendingAvatars(): Promise<void> {
  const paths = await redis.smembers(RedisKey.pendingAvatarIndex)
  for (const relativePath of paths) {
    const key = RedisKey.pendingAvatar(relativePath)
    // pttl <= 0 只认已经过期（或无 TTL）的 key；TTL=0 仍可能有不到 1 秒的有效期，不能提前删除。
    const claimScript =
      "local v=redis.call('get',KEYS[1]); if not v then return 0 end; " +
      "if string.sub(v,-11) == ':processing' then return 0 end; " +
      "local ttl=redis.call('pttl',KEYS[1]); if ttl == -1 or ttl > 0 then return 0 end; " +
      "redis.call('set',KEYS[1],v..':processing','EX',300); return 1"
    const claimed = await redis.eval(claimScript, 1, key)
    if (Number(claimed) !== 1) {
      // key 不存在既可能是 TTL 到期，也可能是确认成功后 finalize 尚未清掉 marker；
      // 先查 DB 引用，确认成功的文件必须保留，未确认的过期资源则继续回收。
      const referenced = await prisma.user.count({ where: { avatar: relativePath } })
      if (referenced > 0) {
        await redis.srem(RedisKey.pendingAvatarIndex, relativePath)
        continue
      }

      const safeRel = relativePath.startsWith(`${UPLOAD_URL_ROOT}/${UploadPartition.AVATARS}/`)
        ? relativePath.slice(`${UPLOAD_URL_ROOT}/`.length)
        : null
      if (safeRel) {
        const filePath = path.resolve(UPLOAD_DIR, safeRel)
        if (filePath.startsWith(path.join(UPLOAD_DIR, UploadPartition.AVATARS) + path.sep)) {
          await unlink(filePath).catch(() => undefined)
        }
      }
      await redis.srem(RedisKey.pendingAvatarIndex, relativePath)
      continue
    }

    // 认领后再查 DB：确认事务可能已经提交但 finalize 尚未清掉 marker，此时只清索引，不删文件。
    const referenced = await prisma.user.count({ where: { avatar: relativePath } })
    if (referenced > 0) {
      await redis.del(key)
      await redis.srem(RedisKey.pendingAvatarIndex, relativePath)
      continue
    }

    const safeRel = relativePath.startsWith(`${UPLOAD_URL_ROOT}/${UploadPartition.AVATARS}/`)
      ? relativePath.slice(`${UPLOAD_URL_ROOT}/`.length)
      : null
    if (safeRel) {
      const filePath = path.resolve(UPLOAD_DIR, safeRel)
      if (filePath.startsWith(path.join(UPLOAD_DIR, UploadPartition.AVATARS) + path.sep)) {
        await unlink(filePath).catch(() => undefined)
      }
    }
    await redis.del(key)
    await redis.srem(RedisKey.pendingAvatarIndex, relativePath)
  }
}

/** 删除已被替换且不再引用的用户头像，并回收真人用户配额；导入影子头像不计入配额。 */
export async function cleanupReplacedAvatar(
  relativePath: string | null,
  userId: number,
  charged: boolean,
): Promise<void> {
  if (!relativePath || !relativePath.startsWith(`${UPLOAD_URL_ROOT}/${UploadPartition.AVATARS}/`)) return
  const referenced = await prisma.user.count({ where: { avatar: relativePath } })
  if (referenced > 0) return

  const safeRel = relativePath.slice(`${UPLOAD_URL_ROOT}/`.length)
  const filePath = path.resolve(UPLOAD_DIR, safeRel)
  if (!filePath.startsWith(path.join(UPLOAD_DIR, UploadPartition.AVATARS) + path.sep)) return
  let fileSize = 0
  try {
    const fileStat = await stat(filePath)
    if (fileStat.isFile()) fileSize = fileStat.size
    await unlink(filePath)
  } catch {
    return
  }

  if (charged && fileSize > 0) {
    await prisma.user.updateMany({
      where: { id: userId, uploadSize: { gte: fileSize } },
      data: { uploadSize: { decrement: fileSize } },
    })
  }
}


/**
 * 允许**用户上传写入**的分区（`POST /api/upload` 的 `partition` 参数取值域）。
 *
 * 只有 `posts` 与 `avatars` 两个：`legacy` 是导入回填的历史落点、`system` 是运营素材，
 * 都不接受用户直传 —— 所以这里不是 `UploadPartitionName` 全集的别名，是刻意收窄的子集。
 */
export type UploadTargetPartition = typeof UploadPartition.POSTS | typeof UploadPartition.AVATARS

/**
 * 分区 → 落盘规则的静态映射表。
 *
 * ⛔⛔ **安全硬要求：请求里的字符串永远不许被拼进 `path.join`**。
 * 落盘用的分区名一律是 `UploadPartition` 常量（本表的键由常量计算得出），
 * 请求字符串只用来**查表**、命中即换成常量本身（见 `parseUploadPartition`）。
 * 若把请求值当路径段直接拼接，`partition=../../..` 就是任意目录写入。
 * 表里没有的键 → 直接抛错，不存在「未知分区兜底建目录」这条路。
 */
const PARTITION_RULES: Record<
  UploadTargetPartition,
  {
    /** 是否插入 YYYYMMDD 子目录 */
    dated: boolean
    /**
     * 文件名前缀。头像必须有一个字母前缀：
     * nanoid 默认字母表 64 字符含 `-` 与 `_`，而头像路径白名单
     * （utils/avatar.ts 的 `UPLOADED_AVATAR_RE`）要求**首字符是字母或数字**，
     * 裸 nanoid 有 2/64 = 3.125% 概率以 `-`/`_` 开头 → 上传成功但落库被拒。
     * 加前缀彻底消除这个概率性失败。
     *
     * ⛔ **该前缀是 `UPLOADED_AVATAR_RE` 的隐式依赖**：两处任一方放宽或收紧字符集，
     * 都必须同步复查另一处。⛔ 别当作「没用的装饰」顺手删掉 ——
     * 删掉之后 96.875% 的上传依然正常，剩下 3.125% 概率性失败，上线后极难归因。
     */
    prefix: string
  }
> = {
  [UploadPartition.POSTS]: { dated: true, prefix: '' },
  [UploadPartition.AVATARS]: { dated: false, prefix: 'a' },
}

/**
 * 请求值 → 分区常量的查找表。
 *
 * 用 `Map` 而不是普通对象：对象查表遇到 `partition=__proto__` / `constructor` 这类键
 * 会命中原型链上的属性（真值），`Map` 只认自己 set 过的键，天然免疫原型污染。
 * value 一律是 `UploadPartition` 常量本身，因此**返回值与请求字符串没有身份关系**。
 */
const PARTITION_LOOKUP = new Map<string, UploadTargetPartition>([
  [UploadPartition.POSTS, UploadPartition.POSTS],
  [UploadPartition.AVATARS, UploadPartition.AVATARS],
])

/**
 * 把请求里的 `partition` 参数收敛成合法分区（**服务端白名单，不信任客户端**）。
 *
 * @param raw query 参数原值；缺省/空串 → 默认 `posts`
 *   （向后兼容：现有发帖/评论配图调用方一个字都不用改）
 * @returns 白名单内的分区常量
 * @throws AppError 400 —— 非空且不在白名单内时；⛔ 不做「模糊匹配」「转小写再猜」这类宽容处理
 */
export function parseUploadPartition(raw: string | undefined | null): UploadTargetPartition {
  if (raw === undefined || raw === null || raw === '') return UploadPartition.POSTS
  const hit = PARTITION_LOOKUP.get(raw)
  if (hit) return hit
  throw new AppError(
    `无效的上传分区：${raw}（仅支持 ${UploadPartition.POSTS} / ${UploadPartition.AVATARS}）`,
    400,
    ErrorCode.VALIDATION_ERROR,
  )
}

/** 上传结果 */
export interface UploadResult {
  /** 完整图片 URL（UPLOAD_BASE_URL + 相对路径） */
  url: string
  /** 相对路径，存进 content 用这个 */
  path: string
  /** 实际写入的字节数 */
  size: number
}

/**
 * 保存用户上传的图片。
 * 完整校验链：类型 → 单文件大小 → 上传频率 → 用户总量 → 处理 → 落盘。
 *
 * ⚠️ **头像的 2MB / 512px 治理不在这里**：本通道是通用上传（正文图也走它，上限本就更宽松），
 * 「这张图要当头像」只有在 `PUT /api/user/me/avatar` 落库那一刻才确定，
 * 故体积/边长强制由 `utils/avatar.ts` 的 `enforceUploadedAvatarLimits()` 在落库路径上做
 * （绕过前端直接 POST 也拦得住）。本函数**只负责落对分区**，⛔ 不要在这里另立一套头像上限，
 * 否则同一规则会有两份真理。
 *
 * @param userId 上传者 id（用于频率与总量计数）
 * @param buffer 原始文件内容
 * @param mimetype 客户端声明的 MIME（**不被信任**，实际格式用 sharp 读魔数）
 * @param partition 落盘分区；必须来自 `parseUploadPartition()` 的白名单结果，
 *   ⛔ 不接受调用方自己拼的字符串
 */
export async function saveImage(
  userId: number,
  buffer: Buffer,
  mimetype: string,
  partition: UploadTargetPartition = UploadPartition.POSTS,
): Promise<UploadResult> {
  // 1. 文件存在性
  if (!buffer || buffer.length === 0) {
    throw new AppError('请选择文件', 400, ErrorCode.UPLOAD_NO_FILE)
  }

  const limits = await getLimitsConfig()

  // 2. 单文件大小限制（运行时限制受启动时 multipart 安全上限保护）
  if (buffer.length > limits.uploadMaxFileSize) {
    const fileMb = buffer.length / 1024 / 1024
    const maxMb = limits.uploadMaxFileSize / 1024 / 1024
    throw new AppError(
      `文件 ${fileMb.toFixed(1)}MB 超出单文件上限 ${maxMb}MB`,
      413,
      ErrorCode.UPLOAD_FILE_TOO_LARGE,
    )
  }

  // 3. 上传频率限制（每分钟最多动态配置的次数）
  await checkRateLimit(userId, limits.uploadMaxPerMinute)

  // 4. 检测真实图片格式（不信任客户端 mimetype，用 sharp 读魔数）
  let format: string
  try {
    const meta = await sharp(buffer, { failOn: 'error' }).metadata()
    format = meta.format ?? ''
  } catch {
    throw new AppError('仅支持 JPG/PNG/GIF/WebP 图片', 400, ErrorCode.UPLOAD_INVALID_TYPE)
  }

  const supported = ['jpeg', 'png', 'gif', 'webp']
  if (!supported.includes(format)) {
    throw new AppError('仅支持 JPG/PNG/GIF/WebP 图片', 400, ErrorCode.UPLOAD_INVALID_TYPE)
  }

  // 5. 读取用户当前配额；最终输出字节数在处理后校验
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { uploadSize: true, uploadQuotaBonus: true },
  })
  const userTotal = user?.uploadSize ?? 0
  const effectiveLimit = limits.uploadMaxUserTotalSize + (user?.uploadQuotaBonus ?? 0)

  // 6. 处理：GIF 原样保留；其他格式转 WebP（限宽 1920，质量 85，自动清除 EXIF）
  let outputBuffer: Buffer
  let ext: string
  if (format === 'gif') {
    // GIF 转 GIF 会丢帧，直接原样保存保留动画
    outputBuffer = buffer
    ext = 'gif'
  } else {
    outputBuffer = await sharp(buffer)
      .rotate() // 按 EXIF 方向矫正
      .resize({ width: 1920, withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer()
    ext = 'webp'
  }

  if (userTotal + outputBuffer.length > effectiveLimit) {
    const mb = Math.round(effectiveLimit / 1024 / 1024)
    throw new AppError(`上传总量已达上限（${mb}MB）`, 413, ErrorCode.UPLOAD_USER_TOTAL_EXCEEDED)
  }

  // 7. 落盘：按分区查表决定是否分日期目录
  //    - posts   → public/uploads/posts/YYYYMMDD/nanoid.ext（日期子目录防单目录文件数爆炸）
  //    - avatars → public/uploads/avatars/a{nanoid}.ext（§13 决定 3：头像是低频覆盖写，
  //      按日期分目录只会散落出一堆孤儿；影子头像与用户头像同分区统一管理）
  //    ⛔ 路径里的分区段是 `UploadPartition` 常量，**不是**请求里的字符串，见 PARTITION_RULES 注释。
  const rule = PARTITION_RULES[partition]
  const filename = `${rule.prefix}${nanoid(6)}.${ext}`
  const segments = rule.dated ? [formatDateDir(new Date()), filename] : [filename]
  const relativePath = uploadRelativePath(partition, ...segments)
  const filePath = path.join(UPLOAD_DIR, partition, ...segments)

  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, outputBuffer)
  } catch {
    throw new AppError('图片保存失败，请重试', 500, ErrorCode.UPLOAD_PROCESS_FAILED)
  }

  // 8. 头像先登记为待确认资源；只有 PUT 确认成功后才计入用户配额。
  // 正文图保持原有「上传即计费」语义。正文必须用带条件的原子更新，避免并发上传同时通过前置读取而超额。
  if (partition === UploadPartition.AVATARS) {
    try {
      await registerPendingAvatar(relativePath, userId, outputBuffer.length)
    } catch {
      await unlink(filePath).catch(() => undefined)
      throw new AppError('图片保存失败，请重试', 500, ErrorCode.UPLOAD_PROCESS_FAILED)
    }
  } else {
    try {
      const claimed = await prisma.user.updateMany({
        where: { id: userId, uploadSize: { lte: effectiveLimit - outputBuffer.length } },
        data: { uploadSize: { increment: outputBuffer.length } },
      })
      if (claimed.count !== 1) {
        await unlink(filePath).catch(() => undefined)
        throw new AppError('上传总量已达上限', 413, ErrorCode.UPLOAD_USER_TOTAL_EXCEEDED)
      }
    } catch (err) {
      // 业务更新失败时回收刚写入的文件；进程崩溃则由后续孤儿扫描兜底。
      if (err instanceof AppError) throw err
      await unlink(filePath).catch(() => undefined)
      throw new AppError('图片保存失败，请重试', 500, ErrorCode.UPLOAD_PROCESS_FAILED)
    }
  }

  // 9. 拼接完整 URL 返回（DB 里只存 relativePath）
  return {
    url: `${config.UPLOAD_BASE_URL}${relativePath}`,
    path: relativePath,
    size: outputBuffer.length,
  }
}

/**
 * 上传频率限制：每分钟最多 UPLOAD_MAX_UPLOADS_PER_MINUTE 次。
 * Redis 计数器 key 精确到分钟，TTL 60s 自动重置。
 */
async function checkRateLimit(userId: number, maxPerMinute: number): Promise<void> {
  const minute = formatMinute(new Date())
  const key = RedisKey.uploadRate(userId, minute)

  // INCR 后如果 > 上限 → 拒绝（第 N+1 次越界，正好每分钟最多 N 次）
  const count = await redis.incr(key)
  if (count === 1) {
    // 首次计数设置 TTL，自动过期重置
    await redis.expire(key, 60)
  }
  if (count > maxPerMinute) {
    throw new AppError(
      `上传太频繁，请稍后再试（每分钟最多 ${maxPerMinute} 张）`,
      429,
      ErrorCode.UPLOAD_RATE_LIMITED,
    )
  }
}

/**
 * 从 Markdown content 中提取引用的本地图片相对路径。
 * 同时兼容：相对路径 ![](/uploads/...) 与历史绝对 URL ![](https://host/uploads/...)
 * （后者取 /uploads/ 段，用于清理此前误存完整 URL 的孤儿文件）。
 *
 * ⚠️ `[^)\s]+` 是**跨层级**匹配（不排斥 `/`），所以三种形态一网打尽：
 * 旧 `/uploads/20260812/x.webp`、新 `/uploads/posts/20260904/x.webp`、
 * 迁入 `/uploads/legacy/x.png`。**不要为了「只清 posts 分区」加分区断言**，
 * 否则旧日期目录的孤儿文件立刻变成永久垃圾。
 */
export function extractImagePaths(content: string): string[] {
  // 根段取常量（后端准则⑩）；`/uploads` 无正则元字符，可直接内插
  const regex = new RegExp(
    String.raw`!\[[^\]]*\]\((?:https?:\/\/[^)\s]*)?(${UPLOAD_URL_ROOT}\/[^)\s]+)\)`,
    'g',
  )
  const paths: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    const p = match[1]
    if (!paths.includes(p)) paths.push(p)
  }
  return paths
}

/**
 * 删除帖子引用的本地图片，并同步 author 的 uploadSize。
 * 文件不存在时忽略；unlink 失败只记日志不影响主流程。
 *
 * ⚠️ 分区无关：只要求路径在 `/uploads/` 根内，**层级与分区名一概不校验**，
 * 因此新分区路径（`posts/YYYYMMDD/`）与旧日期目录路径（`20260812/`）都能清。
 */
export async function cleanPostImages(authorId: number, imagePaths: string[]): Promise<void> {
  let freedBytes = 0
  const emptyDirs = new Set<string>()
  const uploadRootPrefix = `${UPLOAD_URL_ROOT}/`

  for (const relPath of imagePaths) {
    // 只允许删除 uploads 目录内的文件，防路径穿越
    const safeRel = relPath.startsWith(uploadRootPrefix)
      ? relPath.slice(uploadRootPrefix.length)
      : null
    if (!safeRel) continue

    // 防路径穿越：resolve 后必须仍位于 UPLOAD_DIR 内（/uploads/../../x 会逃出 uploads 目录删除任意文件）
    const filePath = path.resolve(UPLOAD_DIR, safeRel)
    if (filePath !== UPLOAD_DIR && !filePath.startsWith(UPLOAD_DIR + path.sep)) continue
    const dirPath = path.dirname(filePath)

    try {
      const fileStat = await stat(filePath)
      if (fileStat.isFile()) {
        freedBytes += fileStat.size
        await unlink(filePath)
      }
      // 记录父目录，稍后尝试清理空目录
      emptyDirs.add(dirPath)
    } catch (err) {
      // 文件不存在等 → 忽略，不中断主流程
      console.error('[upload] clean image failed:', relPath, err)
    }
  }

  // 作者上传总量扣除已删除图片大小
  if (freedBytes > 0) {
    await prisma.user.update({
      where: { id: authorId },
      data: { uploadSize: { decrement: freedBytes } },
    })
  }

  // 清理空的日期目录（当目录里没文件了才删）
  //
  // 用 rmdir 而不是 unlink：unlink 对目录必然抛 EPERM/EISDIR，被下面的 catch 静默吃掉
  // → 这段代码此前是**空转**，空日期目录一直残留。分区化之后目录变成
  // `posts/YYYYMMDD/`，空目录只会更多，所以这里顺手修正（一行）。
  for (const dirPath of emptyDirs) {
    // 兜底护栏：只删「分区内的子目录」，绝不删 uploads 根或分区根本身
    // （`/uploads/x.webp` 这种历史平铺路径的 dirname 就是 uploads 根，
    //   若它恰好被清空，rmdir 会把整个上传根删掉）
    const relDir = path.relative(UPLOAD_DIR, dirPath)
    if (!relDir || PARTITION_ROOTS.has(relDir)) continue

    try {
      const files = await readdir(dirPath)
      if (files.length === 0) {
        await rmdir(dirPath)
      }
    } catch {
      // 忽略，目录清理失败不影响主流程
    }
  }
}

/** 顶层分区目录名集合，用于空目录清理的护栏（分区根是长期目录，不随文件清空而删） */
const PARTITION_ROOTS = new Set<string>(Object.values(UploadPartition))

/** 日期目录格式：YYYYMMDD */
function formatDateDir(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** 分钟格式：YYYYMMDDHHMM，用于上传频率计数 key */
function formatMinute(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${formatDateDir(date)}${h}${m}`
}
