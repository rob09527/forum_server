import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { PointType, UserRole, UserStatus } from '../../constants/business.js'
import type { UserRoleType, UserStatusType } from '../../constants/business.js'
import { NotFoundError, ValidationError } from '../../utils/errors.js'
import { hashPassword } from '../../utils/password.js'
import { revokeAllUserSessions } from '../auth/auth-token.service.js'

/**
 * 管理端用户治理服务。
 * 由 admin 后端（Cool Admin）通过 /api/admin/* 调用，服务间密钥鉴权，非浏览器直连。
 *
 * 与用户自助的 auth/points 服务严格区分：这里都是管理员的人工操作，语义不同。
 * 典型差异：调积分只动余额 points、不触碰累计 totalPointsEarned（不影响等级），
 * 且写 type='transfer' 流水，与「行为发分」的 earnPoints 分开对账。
 */

/** 校验角色取值，非法直接 400 */
function assertRole(role: string): asserts role is UserRoleType {
  if (!Object.values(UserRole).includes(role as UserRoleType)) {
    throw new ValidationError(`角色必须是 ${Object.values(UserRole).join('/')}`)
  }
}

/** 校验账号状态取值，非法直接 400 */
function assertStatus(status: string): asserts status is UserStatusType {
  if (!Object.values(UserStatus).includes(status as UserStatusType)) {
    throw new ValidationError(`状态必须是 ${Object.values(UserStatus).join('/')}`)
  }
}

/** 确认用户存在，不存在抛 404，避免 Prisma P2025 落成 500 */
async function ensureUserExists(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) throw new NotFoundError('用户')
}

/** 修改用户角色（user/mod/admin），无联动，直改 role */
export async function adminChangeRole(
  userId: number,
  role: string,
): Promise<{ id: number; role: string }> {
  assertRole(role)
  await ensureUserExists(userId)
  await prisma.user.update({ where: { id: userId }, data: { role } })
  return { id: userId, role }
}

/**
 * 修改账号状态（active/banned/muted）。
 * 封禁(banned)时立即踢下线：删除该用户全部 session。
 */
export async function adminChangeStatus(
  userId: number,
  status: string,
): Promise<{ id: number; status: string }> {
  assertStatus(status)
  await ensureUserExists(userId)
  await prisma.user.update({ where: { id: userId }, data: { status } })

  if (status === UserStatus.BANNED) {
    await revokeAllUserSessions(userId)
  }

  return { id: userId, status }
}

/**
 * 人工调整鸡腿余额（可增可减）。
 * 只动 points 余额，不动 totalPointsEarned（累计只增不减，等级不受人工调整影响）；
 * 写 type='transfer' 流水并记录调整后余额与操作者，保证对账可追溯。
 * @param operator 操作者用户名（admin 后端从登录会话透传），未传则留空，便于审计追责
 */
export async function adminAdjustPoints(
  userId: number,
  delta: number,
  operator?: string,
): Promise<{ id: number; points: number }> {
  if (!Number.isInteger(delta) || delta === 0) {
    throw new ValidationError('积分调整值必须是非零整数')
  }
  await ensureUserExists(userId)

  const op = typeof operator === 'string' && operator.trim() !== '' ? operator.trim() : null

  const points = await prisma.$transaction(async (db: Prisma.TransactionClient) => {
    const updated = await db.user.update({
      where: { id: userId },
      data: { points: { increment: delta } },
      select: { points: true },
    })

    // 余额不允许被调成负数
    if (updated.points < 0) {
      throw new ValidationError('调整后积分余额不能为负')
    }

    await db.pointLog.create({
      data: { userId, type: PointType.TRANSFER, delta, balanceAfter: updated.points, operator: op },
    })

    return updated.points
  })

  return { id: userId, points }
}

/**
 * 重置用户密码（管理员代设）。
 * 复用注册同款 argon2id 参数写 passwordHash；密码最短 8 位，与注册一致。
 */
export async function adminResetPassword(
  userId: number,
  password: string,
): Promise<{ id: number }> {
  if (typeof password !== 'string' || password.length < 8) {
    throw new ValidationError('密码至少 8 位')
  }
  await ensureUserExists(userId)

  const passwordHash = await hashPassword(password)
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } })
  // 重置密码后强制旧会话失效（最常见场景是被盗号，必须把攻击者持有的 token 一并踢掉）
  await revokeAllUserSessions(userId)

  return { id: userId }
}
