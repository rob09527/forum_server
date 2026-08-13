/** Fastify/Ajv 校验失败的单个错误项 */
interface ValidationIssue {
  keyword: string
  instancePath?: string
  params?: {
    limit?: number
    missingProperty?: string
  }
}

/**
 * 把 Fastify 的 schema 校验错误转成中文可读消息。
 * instancePath 形如 /username、/password、/tags；去掉前导 / 即字段名。
 */
export function validationMessage(rawError: { validation?: unknown; message?: string }): string {
  const issues = rawError.validation as ValidationIssue[] | undefined
  if (!issues || issues.length === 0) {
    return rawError.message || '参数校验失败'
  }

  const first = issues[0]
  const field = (first.instancePath ?? '').replace(/^\//, '') || '参数'

  switch (first.keyword) {
    case 'required':
      return `缺少必填字段 ${first.params?.missingProperty ?? ''}`
    case 'minLength':
      return `${field} 长度不能少于 ${first.params?.limit ?? 0} 个字符`
    case 'maxLength':
      return `${field} 长度不能超过 ${first.params?.limit ?? 0} 个字符`
    case 'minimum':
      return `${field} 不能小于 ${first.params?.limit ?? 0}`
    case 'maximum':
      return `${field} 不能超过 ${first.params?.limit ?? 0}`
    case 'minItems':
      return `${field} 数量不能少于 ${first.params?.limit ?? 0}`
    case 'maxItems':
      return `${field} 数量不能超过 ${first.params?.limit ?? 0}`
    case 'enum':
      return `${field} 取值不合法`
    case 'type':
      return `${field} 类型不正确`
    case 'pattern':
      return `${field} 格式不正确`
    case 'format':
      return `${field} 格式不正确`
    default:
      return `${field} 参数不合法`
  }
}
