/**
 * @提及解析工具。
 *
 * 编辑器通过「点选候选」插入的是结构化 Markdown 链接：[@用户名](/user/123)。
 * 用户名只做展示，真正定位用户靠链接里的 id——用户改名后链接仍指向正确的人，
 * 渲染时（marked 原生）也无需按用户名反查，零额外查询。
 *
 * 这里只识别这种结构化形式；手打的 @用户名 不解析，
 * 因此邮箱（foo@bar）、代码里的 @ 不会误判，也不会因用户名改名而失效。
 */

/** 结构化提及链接：[@显示名](/user/数字id) */
const MENTION_LINK_SOURCE = String.raw`\[@[^\]]+\]\(\/user\/(\d+)\)`

/**
 * 从 Markdown 文本中提取被提及用户 ID。
 * - 去重（同一人提及多次只算一次）
 * - 只保留正整数 id（防 `/user/0`、`/user/-1` 等非法值）
 * - 未匹配返回空数组
 */
export function extractMentionedUserIds(markdown: string): number[] {
  if (!markdown) return []

  // 每次调用新建正则实例，避免模块级 /g 正则的 lastIndex 跨调用残留
  const re = new RegExp(MENTION_LINK_SOURCE, 'g')
  const ids = new Set<number>()

  let match: RegExpExecArray | null
  while ((match = re.exec(markdown)) !== null) {
    const id = Number(match[1])
    if (Number.isInteger(id) && id > 0) {
      ids.add(id)
    }
  }

  return [...ids]
}
