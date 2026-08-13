import { ValidationError } from './errors.js'

/**
 * 解析路径参数为 ID（正整数）。
 * 路由从 URL 拿到的 params 是字符串，直接 Number() 遇到非数字会得到 NaN，
 * NaN 流入 Prisma 的 where 会抛非业务错误 → 落 500。这里统一在路由层拦成 400。
 */
export function parseId(raw: string): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id < 1) {
    throw new ValidationError('ID 必须是正整数')
  }
  return id
}
