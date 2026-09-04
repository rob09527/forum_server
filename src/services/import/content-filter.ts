/**
 * NodeLoc 品牌字眼禁用池（导入时整楼作废判据）。
 *
 * 匹配规则：大小写不敏感、子串匹配（`text.toLowerCase().includes(word.toLowerCase())`）。
 * 后续新增字眼直接往 `BANNED_CONTENT_POOL` 数组里加一行字符串即可，匹配逻辑不变。
 *
 * ⚠️ 三个已知误伤点（用户已明确「全部通杀、宁多勿漏」，仍要求入池）：
 * 1. 裸中文等级名（青铜/白银/黄金/钻石/王者）是常见词，会误伤「黄金价格/王者荣耀/钻石会员」等正常内容。
 * 2. `TL0`~`TL4` 子串会命中 `TL431`（稳压芯片）等「TL+数字」token。
 * 3. `discourse` 是英文常见词（论述/话语），会误伤含该英文单词的正文。
 * 若后续需收窄，可把对应项换成词边界正则（如 `\bTL[0-4]\b`）或删除裸中文项。
 */
export const BANNED_CONTENT_POOL: readonly string[] = [
  // —— 品牌词（单条子串覆盖 nodeloc / nodeloc.com / www.nodeloc.com / https://nodeloc.com/... 及任意大小写）——
  'nodeloc',
  // —— 品牌中文变体（与 repair-text-traces.ts 的 MENTION_RE 同源）——
  'NL社区',
  'NL论坛',
  // —— 品牌拆写变体（空格 / 点号 拆写的 Node Loc 形态，用户未想到的关联词 ① ②）——
  'node loc',
  'node.loc',
  // —— NodeLoc 信任等级 TL0~TL4 ——
  'TL0', 'TL1', 'TL2', 'TL3', 'TL4',
  // —— 对应中文等级名（⚠️ 常见词，误伤面大）——
  '青铜', '白银', '黄金', '钻石', '王者',
  // —— 关联词补充：信任等级中英文全名 + 底层论坛引擎（用户未想到的关联词 ③ ④ ⑤）——
  'trust level',
  '信任等级',
  'discourse',
]

/** 判断文本是否命中禁用字眼池；null/undefined 视为未命中。 */
export function containsBannedContent(text: string | null | undefined): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return BANNED_CONTENT_POOL.some((word) => lower.includes(word.toLowerCase()))
}
