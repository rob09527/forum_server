import argon2 from 'argon2'

/**
 * argon2id 参数唯一来源，注册与重置密码共用，禁止在业务代码中散落配置。
 * memoryCost 64 MiB / timeCost 3。注意：改参数会导致已存哈希无法校验，勿随意调整。
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
} as const

/** 对明文密码做 argon2id 哈希 */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS)
}

/** 校验明文密码与哈希是否匹配 */
export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password)
}
