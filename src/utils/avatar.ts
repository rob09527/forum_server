import { ALLOWED_AVATAR_STYLES, AVATARS_PER_STYLE } from '../constants/business.js'

/**
 * 头像生成工具。
 * 权威风格列表为后端 ALLOWED_AVATAR_STYLES（/api/avatar-styles 下发给前端）；
 * 确定性哈希算法与前端 client/app/utils/avatar.ts 的 deterministicLocalAvatar 保持一致，
 * 保证「同用户名在前后端算出的头像路径完全一致」。
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
 * 折叠「生效头像」：租用的付费头像覆盖层未过期时优先，否则回退基础头像。
 * 所有后端投影（AuthorBrief / UserPublic / UserProfile 等）在映射 avatar 时统一调用，
 * 前端仍只读 avatar 字段，无需感知双槽。
 * @param avatar 基础（免费）头像
 * @param decorAvatarValue 租用头像路径快照（User.decorAvatarValue）
 * @param decorAvatarExpireAt 租用头像到期时间
 */
export function effectiveAvatar(
  avatar: string | null,
  decorAvatarValue: string | null,
  decorAvatarExpireAt: Date | null,
  now = new Date(),
): string | null {
  if (decorAvatarValue && decorAvatarExpireAt && decorAvatarExpireAt.getTime() > now.getTime()) {
    return decorAvatarValue
  }
  return avatar
}
