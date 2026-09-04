import path from 'node:path'
import { readFile, writeFile, stat } from 'node:fs/promises'
import sharp from 'sharp'
import type { Metadata } from 'sharp'
import {
  ALLOWED_AVATAR_STYLES,
  AVATARS_PER_STYLE,
  AVATAR_UPLOAD_LIMITS,
} from '../constants/business.js'
import { UploadPartition, UPLOAD_URL_ROOT, isInPartition } from '../constants/upload-paths.js'
import { ErrorCode } from '../constants/error-codes.js'
import { ValidationError } from './errors.js'

/**
 * 头像工具：预置头像的确定性生成 + 头像路径白名单校验 + 自定义上传头像的服务端尺寸治理。
 *
 * 权威风格列表为后端 ALLOWED_AVATAR_STYLES（/api/avatar-styles 下发给前端）；
 * 确定性哈希算法与前端 client/app/utils/avatar.ts 的 deterministicLocalAvatar 保持一致，
 * 保证「同用户名在前后端算出的头像路径完全一致」。
 *
 * 头像商城已于 §9 下线：头像不再是付费商品，任何**合法**头像路径都可直接选用；
 * 「合法」= 下面 assertAllowedAvatarPath 的白名单二选一，禁止任意字符串直存
 * （那等于开放任意外链注入到所有用户的头像位：SSRF / 追踪像素 / 站外图挂载）。
 */

/** 简单确定性哈希（djb2），把用户名稳定映射到 0..mod-1。前端 hashIndex 同款，勿单独改动 */
function hashIndex(name: string, mod: number): number {
  let h = 5381
  for (let i = 0; i < name.length; i++) {
    h = (h * 33 + name.charCodeAt(i)) >>> 0
  }
  return h % mod
}

/** 用户名 → 确定性本地头像路径（同用户名永远同头像）。用于注册默认头像，无外网依赖 */
export function deterministicLocalAvatar(username: string): string {
  const idx = hashIndex(username, ALLOWED_AVATAR_STYLES.length * AVATARS_PER_STYLE)
  const style = ALLOWED_AVATAR_STYLES[Math.floor(idx / AVATARS_PER_STYLE)]
  const n = (idx % AVATARS_PER_STYLE) + 1
  return `/avatars/${style}/avatar-${String(n).padStart(2, '0')}.svg`
}

/**
 * 形态一：本地预置头像路径 `/avatars/{style}/avatar-{nn}.svg`。
 * 三重校验（正则 + 风格白名单 + 序号范围）合起来才是防路径穿越的完整闸门，
 * ⛔ 缺一不可 —— 只有正则时 `/avatars/../../etc/x/avatar-01.svg` 里的 `..` 会被
 * `[a-z0-9-]+` 挡住，但风格白名单才是「目录真实存在」的唯一保证。
 */
const PRESET_AVATAR_RE = /^\/avatars\/([a-z0-9-]+)\/avatar-(\d{2})\.svg$/

/**
 * 形态二：自定义上传的头像路径 `/uploads/avatars/{文件名}.{ext}`。
 *
 * 只允许**单层**文件名，字符集不含 `/` 也不含前导 `.`，因此 `..` 与多级穿越在正则层就不可能出现；
 * 分区归属另由 `isInPartition` 复核（§9.2 要求，upload-paths.ts 是分区的单一事实来源）。
 * 扩展名白名单与 upload.service 的 MIME 白名单同口径，svg 刻意**不在其中** ——
 * svg 可内嵌 script，用户可上传的 svg 是 XSS 面（预置头像的 svg 是我们自己的静态资源，性质不同）。
 *
 * ⛔ **首字符必须是字母或数字这条，与 upload.service 的头像文件名前缀是一对隐式耦合**：
 * nanoid 默认字母表含 `-`/`_`，裸 nanoid 有 2/64 = 3.125% 概率以它们开头 → 上传成功但落库被本正则拒，
 * 故上传侧给头像文件名加了 `a` 前缀（`PARTITION_RULES[AVATARS].prefix`）。
 * 任一方放宽或收紧字符集,**都必须同步复查另一方** —— 这类概率性失败上线后极难归因。
 */
const UPLOADED_AVATAR_RE = new RegExp(
  `^${UPLOAD_URL_ROOT}/${UploadPartition.AVATARS}/[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:png|jpe?g|webp|gif|avif)$`,
  'i',
)

/** 头像路径的两种合法形态 */
export const AvatarPathKind = {
  /** 本地预置模板头像（静态资源，非上传） */
  PRESET: 'preset',
  /** 用户自定义上传（落在 uploads 的 avatars 分区内） */
  UPLOADED: 'uploaded',
} as const
export type AvatarPathKindType = (typeof AvatarPathKind)[keyof typeof AvatarPathKind]

/**
 * 校验头像路径是否为**白名单二选一**，返回命中的形态。
 * 非法一律抛 ValidationError（400 + 人话提示），绝不放行「任意字符串直存」。
 * @param avatar 待落库的头像相对路径
 */
export function assertAllowedAvatarPath(avatar: string): AvatarPathKindType {
  const m = PRESET_AVATAR_RE.exec(avatar)
  if (m) {
    const index = Number(m[2])
    if (
      (ALLOWED_AVATAR_STYLES as readonly string[]).includes(m[1]) &&
      index >= 1 &&
      index <= AVATARS_PER_STYLE
    ) {
      return AvatarPathKind.PRESET
    }
    throw new ValidationError(
      `无效的头像路径: ${avatar}，格式应为 /avatars/{风格}/avatar-01~${String(AVATARS_PER_STYLE).padStart(2, '0')}.svg`,
      ErrorCode.VALIDATION_ERROR,
    )
  }

  // 上传形态：正则（含防穿越）与分区归属都必须通过
  if (UPLOADED_AVATAR_RE.test(avatar) && isInPartition(avatar, UploadPartition.AVATARS)) {
    return AvatarPathKind.UPLOADED
  }

  throw new ValidationError(
    `无效的头像路径: ${avatar}，只接受本地预置头像（/avatars/{风格}/avatar-NN.svg）或站内上传的头像（${UPLOAD_URL_ROOT}/${UploadPartition.AVATARS}/...）`,
    ErrorCode.VALIDATION_ERROR,
  )
}

/** 头像文件在磁盘上的根目录（server/public + 相对路径）；与 upload.service 同一 public 根 */
const PUBLIC_DIR = path.resolve(process.cwd(), 'public')

/**
 * 对**自定义上传**的头像执行服务端强制治理（§9.2 / §13.1）：
 * 1. 体积 > AVATAR_UPLOAD_LIMITS.maxFileSizeBytes → 拒绝（人话提示，不是 500）；
 * 2. 像素边长 > maxEdgePx → **等比缩放后原地覆写**该文件，小图不放大。
 *
 * 为什么在这里做而不是在上传接口里做：上传通道是通用的 `POST /api/upload`（正文图也走它，
 * 上限本就该更宽松），「这张图要当头像」只有在 `PUT /api/user/me/avatar` 落库这一刻才确定。
 * 把闸门放在落库路径上，等于**绕过前端直接 POST 也拦得住** —— 这是用户明确要求的服务端校验。
 *
 * @param avatar 已通过 assertAllowedAvatarPath 且形态为 UPLOADED 的相对路径
 */
export async function enforceUploadedAvatarLimits(avatar: string): Promise<number> {
  // 防穿越兜底：resolve 后必须仍在 public/uploads/avatars 内（正则已挡住，这里是第二道）
  const filePath = path.resolve(PUBLIC_DIR, `.${avatar}`)
  const avatarsDir = path.join(PUBLIC_DIR, UPLOAD_URL_ROOT.slice(1), UploadPartition.AVATARS)
  if (!filePath.startsWith(avatarsDir + path.sep)) {
    throw new ValidationError(`无效的头像路径: ${avatar}`, ErrorCode.VALIDATION_ERROR)
  }

  let size: number
  try {
    size = (await stat(filePath)).size
  } catch {
    // 只落库「已经上传成功」的文件；文件不存在说明前端传了个不存在的路径
    throw new ValidationError('头像文件不存在，请重新上传', ErrorCode.VALIDATION_ERROR)
  }

  if (size > AVATAR_UPLOAD_LIMITS.maxFileSizeBytes) {
    const maxMb = AVATAR_UPLOAD_LIMITS.maxFileSizeBytes / 1024 / 1024
    // 实际体积**向上**取到 2 位小数：四舍五入会把 2.0001MB 显示成「过大（2.0MB），最大 2MB」，
    // 用户看不懂到底超没超；向上取整保证显示值永远严格大于上限
    const actualMb = Math.ceil((size / 1024 / 1024) * 100) / 100
    throw new ValidationError(
      `头像文件过大（${actualMb}MB），最大 ${maxMb}MB`,
      ErrorCode.VALIDATION_ERROR,
    )
  }

  // 等比压缩：只在超过边长上限时改写文件，未超过的原样保留（不做无谓重编码，省一次画质损失）。
  // 动图命中缩放时会因 sharp 未开 animated 而静默丢失动画，故这里刻意拒绝而不自动降级：
  // 用户能当场知道并重选，避免不可察觉的内容损失；请上传 512px 以内的动图，或改用静态图。
  const buffer = await readFile(filePath)
  let meta: Metadata
  try {
    meta = await sharp(buffer).metadata()
  } catch {
    // sharp 读不出元数据 = 不是它认识的图片（改扩展名伪装），拒绝
    throw new ValidationError('头像文件不是有效的图片', ErrorCode.VALIDATION_ERROR)
  }
  const { width, height } = meta
  if (!width || !height) {
    throw new ValidationError('头像文件不是有效的图片', ErrorCode.VALIDATION_ERROR)
  }
  const max = AVATAR_UPLOAD_LIMITS.maxEdgePx
  if (width <= max && height <= max) return size

  // 只在确实需要缩放时拒绝多帧图片；512px 以内的动图保持原样，单帧 GIF 也不受影响。
  if ((meta.pages ?? 1) > 1) {
    throw new ValidationError(
      `动图头像超过 ${max}px 无法自动缩放，请上传 ${max}px 以内的动图，或改用静态图`,
      ErrorCode.VALIDATION_ERROR,
    )
  }

  // fit=inside + withoutEnlargement：长边压到 max、保持比例、绝不放大
  const resized = await sharp(buffer)
    .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
    .toBuffer()
  await writeFile(filePath, resized)
  return resized.length
}
