import { createHash, createHmac } from 'crypto'
import { nanoid } from 'nanoid'
import { config } from '../../config.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { OAuthProvider, UserStatus } from '../../constants/business.js'
import type { UserStatusType } from '../../constants/business.js'
import { ConflictError, ForbiddenError, InvalidCredentialsError, UnauthorizedError } from '../../utils/errors.js'
import { hashPassword, verifyPassword } from '../../utils/password.js'
import { deterministicLocalAvatar } from '../../utils/avatar.js'
import { generateToken } from './auth-token.service.js'
import { prisma } from '../../lib/prisma.js'

/** 返回给前端的用户公开信息，排除 passwordHash 等敏感字段 */
export interface UserPublic {
  /** 用户 ID，自增主键 */
  id: number
  /** 用户名，唯一，3-20 字符，用于展示和 @提及 */
  username: string
  /** 邮箱，唯一；TG 注册时为空(null)，绑定邮箱后才有值 */
  email: string | null
  /** 头像 URL；TG 注册自动填 TG 头像；邮箱注册默认生成 DiceBear 机器人头像 */
  avatar: string | null
  /** 个人简介，最长 200 字符 */
  bio: string | null
  /** 用户等级：claw(鸡爪/新手) | leg(鸡腿/中级) | meat(鸡肉/高级) */
  level: string
  /** 鸡腿积分，通过签到/发帖/评论获得 */
  points: number
  /** 星辰(特殊积分)，通过精华帖/管理奖励获得 */
  stars: number
  /** 管理角色：user(普通用户) | mod(版主) | admin(管理员) */
  role: string
  /** 账号状态：active(正常) | banned(封禁) | muted(禁言) */
  status: UserStatusType
  /** 第三方登录来源：'telegram' 表示 TG 用户；本站邮箱注册为 null */
  oauthProvider: string | null
  /** 注册时间，ISO 8601 格式 */
  createdAt: Date
}

/** 将 Prisma User 转为前端安全的 UserPublic */
function toPublic(user: {
  id: number
  username: string
  email: string | null
  avatar: string | null
  bio: string | null
  level: string
  points: number
  stars: number
  role: string
  status: string
  oauthProvider: string | null
  createdAt: Date
}): UserPublic {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    bio: user.bio,
    level: user.level,
    points: user.points,
    stars: user.stars,
    role: user.role,
    status: user.status as UserStatusType,
    oauthProvider: user.oauthProvider,
    createdAt: user.createdAt,
  }
}

/** 邮箱注册 */
export async function register(input: {
  username: string
  email: string
  password: string
}): Promise<{ user: UserPublic; token: string }> {
  const { username, email, password } = input

  // 查重：email 和 username 不能冲突
  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ email }, { username }],
    },
    select: { email: true, username: true },
  })

  if (existing) {
    if (existing.email === email) {
      throw new ConflictError('该邮箱已被注册', ErrorCode.EMAIL_TAKEN)
    }
    throw new ConflictError('该用户名已被占用', ErrorCode.USERNAME_TAKEN)
  }

  const passwordHash = await hashPassword(password)

  const user = await prisma.user.create({
    data: {
      username,
      email,
      passwordHash,
      // 邮箱注册按用户名确定性映射一个本地预置头像（与前端展示兜底同一算法，无外网依赖）
      avatar: deterministicLocalAvatar(username),
      // oauthProvider 和 oauthId 留 null，表示本站邮箱注册
    },
    select: {
      id: true,
      username: true,
      email: true,
      avatar: true,
      bio: true,
      level: true,
      points: true,
      stars: true,
      role: true,
      status: true,
      oauthProvider: true,
      createdAt: true,
    },
  })

  const token = await generateToken(user.id)

  return { user: toPublic(user), token }
}

/** 邮箱登录 */
export async function login(input: {
  email: string
  password: string
}): Promise<{ user: UserPublic; token: string }> {
  const { email, password } = input

  // 不区分"用户不存在"和"密码错误"——防邮箱枚举
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      username: true,
      email: true,
      avatar: true,
      bio: true,
      level: true,
      points: true,
      stars: true,
      role: true,
      status: true,
      oauthProvider: true,
      createdAt: true,
      passwordHash: true,
    },
  })

  if (!user || !user.passwordHash) {
    // passwordHash 为空 → 这是纯 TG 用户，不能用邮箱登录
    throw new InvalidCredentialsError()
  }

  const valid = await verifyPassword(user.passwordHash, password)
  if (!valid) {
    throw new InvalidCredentialsError()
  }

  // 封禁账号拒绝登录（即使 token 被踢也能重登）
  if (user.status === UserStatus.BANNED) {
    throw new ForbiddenError('账号已被封禁', ErrorCode.ACCOUNT_BANNED)
  }

  const token = await generateToken(user.id)
  // 排除 passwordHash 再返回
  const { passwordHash: _, ...userPublic } = user
  return { user: toPublic(userPublic), token }
}

/**
 * Telegram Login Widget 回调传给前端的原始数据。
 * 字段名遵循 TG Widget 的 snake_case 约定，不做转换。
 */
export interface TelegramAuthData {
  /** TG 用户唯一 ID */
  id: number
  /** TG 用户 first name */
  first_name: string
  /** TG 用户 last name，可能为空 */
  last_name?: string
  /** TG 用户名（不带 @），可能为空 */
  username?: string
  /** TG 头像 URL，可能为空 */
  photo_url?: string
  /** 授权时间戳（Unix 秒） */
  auth_date: number
  /** TG 服务端计算的 HMAC-SHA256 签名，用于验签 */
  hash: string
}

/**
 * TG 登录/注册（合一）。
 * 验签通过后：已有 oauthId → 登录；没有 → 注册新用户。
 */
export async function telegramAuth(
  data: TelegramAuthData,
): Promise<{ user: UserPublic; token: string; isNewUser: boolean }> {
  // 1. 验签：HMAC-SHA256 校验 hash
  const { hash, ...fields } = data
  // 排除 hash，其余字段按 key 字母序排序
  const checkString = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  // secret = SHA256(botToken)
  const secretKey = createHash('sha256')
    .update(config.TELEGRAM_BOT_TOKEN)
    .digest()

  // computed = HMAC-SHA256(secret, dataCheckString)
  const computedHash = createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex')

  if (computedHash !== hash) {
    throw new UnauthorizedError('Telegram 授权验证失败', ErrorCode.INVALID_TELEGRAM_AUTH)
  }

  const tgId = String(data.id)

  // 2. 查找已有用户
  const existing = await prisma.user.findUnique({
    where: { oauthId: tgId },
    select: {
      id: true,
      username: true,
      email: true,
      avatar: true,
      bio: true,
      level: true,
      points: true,
      stars: true,
      role: true,
      status: true,
      oauthProvider: true,
      createdAt: true,
    },
  })

  if (existing) {
    // 封禁账号拒绝登录（老用户也要查状态，否则被封后可绕过）
    if (existing.status === UserStatus.BANNED) {
      throw new ForbiddenError('账号已被封禁', ErrorCode.ACCOUNT_BANNED)
    }
    // 老用户登录
    const token = await generateToken(existing.id)
    return { user: toPublic(existing), token, isNewUser: false }
  }

  // 3. 新用户注册
  // 生成 username：优先 TG 的 username，冲突加后缀，没有则随机
  const tgUsername = data.username ? data.username.replace('@', '') : ''
  const username = await generateUsername(tgUsername)

  const user = await prisma.user.create({
    data: {
      username,
      email: null,
      passwordHash: null,
      avatar: data.photo_url ?? null,
      oauthProvider: OAuthProvider.TELEGRAM,
      oauthId: tgId,
    },
    select: {
      id: true,
      username: true,
      email: true,
      avatar: true,
      bio: true,
      level: true,
      points: true,
      stars: true,
      role: true,
      status: true,
      oauthProvider: true,
      createdAt: true,
    },
  })

  const token = await generateToken(user.id)
  return { user: toPublic(user), token, isNewUser: true }
}

/** 根据 TG 用户名生成本站用户名，冲突时自动加后缀 */
async function generateUsername(tgUsername: string): Promise<string> {
  const base = tgUsername || `user_${nanoid(8)}`

  // 检查是否已存在
  const exists = await prisma.user.findUnique({
    where: { username: base },
    select: { id: true },
  })

  if (!exists) return base

  // 冲突 → 加 6 位短后缀
  const suffix = nanoid(6)
  return `${base}_${suffix}`
}

/**
 * 根据 userId 获取用户公开信息。
 * 用于 GET /api/auth/me 和中间件注入 request.user。
 */
export async function getUserById(userId: number): Promise<UserPublic | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      email: true,
      avatar: true,
      bio: true,
      level: true,
      points: true,
      stars: true,
      role: true,
      status: true,
      oauthProvider: true,
      createdAt: true,
    },
  })
  return user ? toPublic(user) : null
}
