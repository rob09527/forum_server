import { mkdir, unlink, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nanoid } from 'nanoid'
import sharp from 'sharp'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { AppError } from '../../utils/errors.js'

/**
 * 图片上传服务。
 * 核心约定：
 * - DB 只存相对路径（/uploads/20260812/abc.webp），不存完整 URL
 * - API 返回时由 UPLOAD_BASE_URL 拼接完整 URL
 * - GIF 原样保留（表情包动效不丢），其他格式 sharp 转 WebP + strip EXIF
 * - 单文件大小 / 用户总量 / 每分钟次数 均由环境变量控制
 */

/** 图片存储根目录（server/public/uploads） */
const UPLOAD_DIR = path.resolve(process.cwd(), 'public', 'uploads')

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
 */
export async function saveImage(userId: number, buffer: Buffer, mimetype: string): Promise<UploadResult> {
  // 1. 文件存在性
  if (!buffer || buffer.length === 0) {
    throw new AppError('请选择文件', 400, ErrorCode.UPLOAD_NO_FILE)
  }

  // 2. 单文件大小限制（报错带实际大小 + 真实上限，上限走环境变量，不硬编码）
  if (buffer.length > config.UPLOAD_MAX_FILE_SIZE) {
    const fileMb = buffer.length / 1024 / 1024
    const maxMb = config.UPLOAD_MAX_FILE_SIZE / 1024 / 1024
    throw new AppError(
      `文件 ${fileMb.toFixed(1)}MB 超出单文件上限 ${maxMb}MB`,
      413,
      ErrorCode.UPLOAD_FILE_TOO_LARGE,
    )
  }

  // 3. 上传频率限制（每分钟最多 UPLOAD_MAX_UPLOADS_PER_MINUTE 次）
  await checkRateLimit(userId)

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

  // 5. 用户总上传量限制
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { uploadSize: true },
  })
  const userTotal = user?.uploadSize ?? 0
  if (userTotal + buffer.length > config.UPLOAD_MAX_USER_TOTAL_SIZE) {
    const mb = Math.round(config.UPLOAD_MAX_USER_TOTAL_SIZE / 1024 / 1024)
    throw new AppError(`上传总量已达上限（${mb}MB）`, 413, ErrorCode.UPLOAD_USER_TOTAL_EXCEEDED)
  }

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

  // 7. 落盘：public/uploads/YYYYMMDD/nanoid.ext
  const dateDir = formatDateDir(new Date())
  const filename = `${nanoid(6)}.${ext}`
  const relativePath = `/uploads/${dateDir}/${filename}`
  const filePath = path.join(UPLOAD_DIR, dateDir, filename)

  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, outputBuffer)
  } catch {
    throw new AppError('图片保存失败，请重试', 500, ErrorCode.UPLOAD_PROCESS_FAILED)
  }

  // 8. 更新用户累计上传量（实际写入字节数）
  await prisma.user.update({
    where: { id: userId },
    data: { uploadSize: { increment: outputBuffer.length } },
  })

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
async function checkRateLimit(userId: number): Promise<void> {
  const minute = formatMinute(new Date())
  const key = RedisKey.uploadRate(userId, minute)

  // INCR 后如果 > 上限 → 拒绝（第 N+1 次越界，正好每分钟最多 N 次）
  const count = await redis.incr(key)
  if (count === 1) {
    // 首次计数设置 TTL，自动过期重置
    await redis.expire(key, 60)
  }
  if (count > config.UPLOAD_MAX_UPLOADS_PER_MINUTE) {
    throw new AppError(
      `上传太频繁，请稍后再试（每分钟最多 ${config.UPLOAD_MAX_UPLOADS_PER_MINUTE} 张）`,
      429,
      ErrorCode.UPLOAD_RATE_LIMITED,
    )
  }
}

/**
 * 从 Markdown content 中提取引用的本地图片相对路径。
 * 同时兼容：相对路径 ![](/uploads/...) 与历史绝对 URL ![](https://host/uploads/...)
 * （后者取 /uploads/ 段，用于清理此前误存完整 URL 的孤儿文件）。
 */
export function extractImagePaths(content: string): string[] {
  const regex = /!\[[^\]]*\]\((?:https?:\/\/[^)\s]*)?(\/uploads\/[^)\s]+)\)/g
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
 */
export async function cleanPostImages(authorId: number, imagePaths: string[]): Promise<void> {
  let freedBytes = 0
  const emptyDirs = new Set<string>()

  for (const relPath of imagePaths) {
    // 只允许删除 uploads 目录内的文件，防路径穿越
    const safeRel = relPath.startsWith('/uploads/') ? relPath.slice('/uploads/'.length) : null
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
  for (const dirPath of emptyDirs) {
    try {
      const files = await readdir(dirPath)
      if (files.length === 0) {
        await unlink(dirPath)
      }
    } catch {
      // 忽略，目录清理失败不影响主流程
    }
  }
}

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
