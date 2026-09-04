import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../utils/errors.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { deterministicLocalAvatar } from '../../utils/avatar.js'
import { downloadAvatar } from './import-images.js'
import {
  IMPORT_SOURCE,
  SHADOW_EMAIL_DOMAIN,
  IMPORT_AVATAR_SUBDIR,
} from './import-config.js'
import type { DiscoursePost } from './nodeloc-types.js'

/**
 * 影子用户服务:以 NodeLoc 不可变数字 user_id 为身份锚点,
 * 经 import_user_mappings 归一到本地 User(决策 10/13)。
 * - 无凭据不可登录:passwordHash=null(与 TG 用户同一拒登路径,免去数万次 argon2 哈希)
 * - 默认关私信:dmPrivacy='nobody'(可被打赏,不可被私信)
 * - 邮箱 u{sourceUserId}@import.nodeloc.local:唯一、可审计、可按域批量下架
 * - 注册时间取该用户首次被见到的发言时间(近似入站时间,保持时间线自然)
 */

/** 进程内映射缓存:sourceUserId → localUserId,避免每楼查表 */
const userCache = new Map<number, number>()

/** 已删除/系统楼层归属的共享占位账号的虚拟 sourceUserId(对方站不会出现负 id) */
const PLACEHOLDER_SOURCE_ID = -1

/** 占位账号用户名(真实 User 行,承接 user_deleted/system 楼层;造数阶段豁免,积分恒 0) */
export const PLACEHOLDER_USERNAME = '已注销用户'

/**
 * 占位账号的注册时间(固定历史时刻,UTC)。
 * 为什么不能用 now():占位账号在回填启动时创建,取默认 now() 会让它的 createdAt
 * 晚于所有影子用户(影子 createdAt = 对方站首次发言时间,最早也在一年前),
 * 于是首页「最新加入用户」第一名永远是一个叫「已注销用户」的账号(2026-09-03 实测)。
 * 取一个早于任何导入内容的固定值,让它在按注册时间倒序的任何榜单里都排到最后。
 */
const PLACEHOLDER_CREATED_AT = new Date('2020-01-01T00:00:00.000Z')

/** 用户名净化:适配本站 3-20 字符约束,超长截断、过短用 sourceUserId 补齐 */
function sanitizeUsername(username: string, sourceUserId: number): string {
  let name = username.trim().slice(0, 20)
  if (name.length < 3) name = `nl_${sourceUserId}`
  return name
}

/** Prisma 运行时错误可能跨包加载，不能依赖 instanceof。 */
function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: string }).code === 'P2002'
}

async function findImportMapping(sourceUserId: number): Promise<number | null> {
  const mapping = await prisma.importUserMapping.findUnique({
    where: { source_sourceUserId: { source: IMPORT_SOURCE, sourceUserId } },
    select: { localUserId: true },
  })
  return mapping?.localUserId ?? null
}

/**
 * 创建影子用户(含用户名冲突退避:原名 → nl_原名 → nl_{sourceUserId})。
 * 用户和映射必须在同一事务中创建，避免进程崩溃留下无映射的孤儿用户。
 * 并发事务遇到用户名或映射唯一冲突时，优先读取已提交的映射，确保调用方拿到同一用户。
 */
async function createShadowUser(
  sourceUserId: number,
  sourceUsername: string,
  avatarTemplate: string | undefined,
  firstSeenAt: Date,
): Promise<number> {
  // 头像:优先下载对方头像(288px),失败退确定性本地 DiceBear
  let avatar: string | null = null
  if (avatarTemplate) {
    avatar = await downloadAvatar(avatarTemplate, sourceUserId, IMPORT_AVATAR_SUBDIR).catch(() => null)
  }
  if (!avatar) avatar = deterministicLocalAvatar(sourceUsername)

  const base = sanitizeUsername(sourceUsername, sourceUserId)
  const candidates = [base, `nl_${base}`.slice(0, 20), `nl_${sourceUserId}`]

  for (const username of candidates) {
    try {
      const userId = await prisma.$transaction(async (tx) => {
        // 事务内再查一次，避免预检和创建之间的竞态，也让已提交的并发结果直接复用。
        const existing = await tx.importUserMapping.findUnique({
          where: { source_sourceUserId: { source: IMPORT_SOURCE, sourceUserId } },
          select: { localUserId: true },
        })
        if (existing) return existing.localUserId

        const user = await tx.user.create({
          data: {
            username,
            email: `u${sourceUserId}@${SHADOW_EMAIL_DOMAIN}`,
            passwordHash: null,
            avatar,
            dmPrivacy: 'nobody',
            createdAt: firstSeenAt,
            // 前台需按此标记排除导入账号(最新加入用户/系统公告触达),不靠 email 后缀猜
            isShadow: true,
          },
          select: { id: true },
        })
        await tx.importUserMapping.create({
          data: {
            source: IMPORT_SOURCE,
            sourceUserId,
            sourceUsername,
            localUserId: user.id,
          },
        })
        return user.id
      })
      return userId
    } catch (err) {
      if (!isUniqueConflict(err)) throw err
      // 若是同一 source 的并发创建，另一事务可能刚提交映射；绝不继续造用户。
      // 读取失败时继续候选名，最终冲突后再次读取，覆盖提交时序窗口。
      const existingId = await findImportMapping(sourceUserId)
      if (existingId !== null) return existingId
      // 用户名撞车(本地真实用户或另一影子)→ 试下一个候选。
    }
  }

  const existingId = await findImportMapping(sourceUserId)
  if (existingId !== null) return existingId
  throw new AppError(
    `影子用户创建失败(候选用户名全部冲突): source uid=${sourceUserId}`,
    500,
    ErrorCode.INTERNAL_ERROR,
  )
}

/**
 * 按 NodeLoc user_id 取本地用户 id,没有则创建。
 * @param firstSeenAt 该用户首次被见到的发言时间,作为影子账号注册时间
 */
export async function getOrCreateShadowUser(
  sourceUserId: number,
  sourceUsername: string,
  avatarTemplate: string | undefined,
  firstSeenAt: Date,
): Promise<number> {
  const cached = userCache.get(sourceUserId)
  if (cached) return cached

  const mapping = await findImportMapping(sourceUserId)
  if (mapping !== null) {
    userCache.set(sourceUserId, mapping)
    return mapping
  }

  const localId = await createShadowUser(sourceUserId, sourceUsername, avatarTemplate, firstSeenAt)
  userCache.set(sourceUserId, localId)
  return localId
}

/**
 * 获取共享占位账号(user_deleted/system 楼层的归属者),没有则创建。
 * 占位账号不参与造数(积分/关注/打赏恒零),verify 脚本会校验。
 */
export async function getPlaceholderUser(): Promise<number> {
  const cached = userCache.get(PLACEHOLDER_SOURCE_ID)
  if (cached) return cached

  const mapping = await findImportMapping(PLACEHOLDER_SOURCE_ID)
  if (mapping !== null) {
    userCache.set(PLACEHOLDER_SOURCE_ID, mapping)
    return mapping
  }

  try {
    const localId = await prisma.$transaction(async (tx) => {
      const existing = await tx.importUserMapping.findUnique({
        where: {
          source_sourceUserId: {
            source: IMPORT_SOURCE,
            sourceUserId: PLACEHOLDER_SOURCE_ID,
          },
        },
        select: { localUserId: true },
      })
      if (existing) return existing.localUserId

      const user = await tx.user.create({
        data: {
          username: PLACEHOLDER_USERNAME,
          email: `placeholder@${SHADOW_EMAIL_DOMAIN}`,
          passwordHash: null,
          avatar: deterministicLocalAvatar(PLACEHOLDER_USERNAME),
          dmPrivacy: 'nobody',
          createdAt: PLACEHOLDER_CREATED_AT,
          isShadow: true,
        },
        select: { id: true },
      })
      await tx.importUserMapping.create({
        data: {
          source: IMPORT_SOURCE,
          sourceUserId: PLACEHOLDER_SOURCE_ID,
          sourceUsername: 'system/deleted',
          localUserId: user.id,
        },
      })
      return user.id
    })
    userCache.set(PLACEHOLDER_SOURCE_ID, localId)
    return localId
  } catch (err) {
    if (!isUniqueConflict(err)) throw err
    // 用户名冲突可能是历史孤儿或并发创建；映射提交后才视为成功。
    const existingId = await findImportMapping(PLACEHOLDER_SOURCE_ID)
    if (existingId !== null) return existingId
    throw new AppError(
      '占位用户创建失败(唯一约束冲突但映射不存在)',
      500,
      ErrorCode.INTERNAL_ERROR,
    )
  }
}

/**
 * 只查占位账号的本地用户 id,不存在返回 null(与 getPlaceholderUser 的唯一区别:绝不创建)。
 * 为什么需要它:前台要把「已注销用户」从 @提及候选里剔掉,但前台请求路径上不能有写库副作用,
 * 也不能拿用户名字符串硬编码判定(占位账号改名后判定就静默失效)。
 * 结果进程内缓存(占位账号一旦建成其 id 不再变化),避免每次搜索多一次查表。
 * @returns 占位账号的 users.id;导入尚未跑过时为 null
 */
export async function findPlaceholderUserId(): Promise<number | null> {
  const cached = userCache.get(PLACEHOLDER_SOURCE_ID)
  if (cached) return cached

  const mapping = await findImportMapping(PLACEHOLDER_SOURCE_ID)
  if (mapping === null) return null

  userCache.set(PLACEHOLDER_SOURCE_ID, mapping)
  return mapping
}

/** 楼层作者归一入口:system(id≤0)/已删除作者 → 占位账号,其余走影子用户 */
export async function resolvePostAuthor(post: DiscoursePost): Promise<number> {
  if (!post.user_id || post.user_id <= 0 || post.user_deleted) {
    return getPlaceholderUser()
  }
  return getOrCreateShadowUser(
    post.user_id,
    post.username,
    post.avatar_template,
    new Date(post.created_at),
  )
}
