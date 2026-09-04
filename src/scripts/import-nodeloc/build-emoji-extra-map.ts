/**
 * 生成 services/import/emoji-extra-map.ts —— node-emoji 与 unicode-emoji-json 都解析不到的
 * 残余 shortcode 兜底表。
 *
 * 运行:pnpm tsx src/scripts/import-nodeloc/build-emoji-extra-map.ts
 *
 * 为什么需要这一级:NodeLoc 的表情词表混用了两套命名(GitHub/gemoji 短名如 tada、
 * CLDR slug 如 grinning_face),clean-markdown.ts 已用两个词表覆盖了 1856/1895 个。
 * 剩下 39 个是**系统性命名差异**,不是冷门表情:
 *   - 国旗:对方叫 china / germany / united_states,CLDR slug 是 flag_china …(共 25 个)
 *   - 血型按键:a_button_blood_type → a_button
 *   - 变音符号:türkiye → flag_turkiye、curaçao → flag_curacao、piñata → pinata
 *   - 个别别名:yoyo → yo_yo、ten → keycap_10 等
 * NodeLoc 是机场/VPS/网络服务社区,国旗 shortcode 是高频用法,漏了会在正文里
 * 留下字面量 `:china:`,所以这一级必须补。
 *
 * 产物是静态字面量(不含联网逻辑),导入器与线上增量 worker 只读该常量。
 * 对方新增表情后重跑本脚本即可。
 */

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as nodeEmoji from 'node-emoji'
import { fetchNodelocJson } from '../../services/import/nodeloc-client.js'
import { CUSTOM_STICKER_FILES } from '../../services/import/sticker-manifest.js'

const require = createRequire(import.meta.url)
const dataByEmoji = require('unicode-emoji-json') as Record<string, { slug: string }>

/** CLDR slug → emoji 字符(与 clean-markdown.ts 同一口径) */
const emojiBySlug = new Map<string, string>()
for (const [char, meta] of Object.entries(dataByEmoji)) {
  if (!emojiBySlug.has(meta.slug)) emojiBySlug.set(meta.slug, char)
}

/** /emojis.json 单项(只用 name/url) */
interface EmojiItem {
  /** shortcode(不含冒号) */
  name: string
  /** 图片 URL,含 /uploads/ 的是站点自定义贴图 */
  url: string
}

/** 去掉变音符号:türkiye → turkiye、curaçao → curacao、piñata → pinata */
function deaccent(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** 规则兜底解析不出来时的手工别名(两套词表都没有对应命名) */
const MANUAL_ALIASES: Record<string, string> = {
  yoyo: 'yo_yo',
  ten: 'keycap_10',
  cocos_keeling_islands: 'flag_cocos_islands',
  myanmar_burma: 'flag_myanmar',
  us_outlying_islands: 'flag_u_s_outlying_islands',
}

/** clean-markdown.ts 现有两级查找的口径,用于判定「是否已被覆盖」 */
function resolvedByExisting(name: string): boolean {
  return Boolean(nodeEmoji.get(name) ?? emojiBySlug.get(name.toLowerCase()))
}

/** 补充规则:逐级尝试国旗前缀 / 血型后缀 / 变音符号 / 手工别名 */
function resolveExtra(name: string): string | null {
  const candidates = [
    MANUAL_ALIASES[name],
    name.replace(/_blood_type$/, ''),
    `flag_${name}`,
    deaccent(name),
    `flag_${deaccent(name)}`,
  ].filter((c): c is string => Boolean(c))

  for (const candidate of candidates) {
    const hit = emojiBySlug.get(candidate) ?? nodeEmoji.get(candidate)
    if (hit) return hit
  }
  return null
}

async function main(): Promise<void> {
  const data = await fetchNodelocJson<Record<string, EmojiItem[]>>('/emojis.json')
  if (!data) throw new Error('拉取 /emojis.json 失败(返回 404/403)')

  const extra: Record<string, string> = {}
  const unresolved: string[] = []

  for (const items of Object.values(data)) {
    for (const item of items) {
      // 自定义贴图由 sticker-manifest.ts 负责,不进本表
      if (item.url.includes('/uploads/') || CUSTOM_STICKER_FILES[item.name]) continue
      if (resolvedByExisting(item.name)) continue

      const char = resolveExtra(item.name)
      if (char) extra[item.name] = char
      else unresolved.push(item.name)
    }
  }

  const entries = Object.entries(extra).sort(([a], [b]) => a.localeCompare(b))
  const body = entries.map(([name, char]) => `  ${JSON.stringify(name)}: '${char}',`).join('\n')

  const file = `/**
 * 表情 shortcode 兜底表:node-emoji(gemoji 短名)与 unicode-emoji-json(CLDR slug)
 * 两套词表都解析不到的残余 shortcode → Unicode 字符。
 *
 * 由 src/scripts/import-nodeloc/build-emoji-extra-map.ts 依据 NodeLoc /emojis.json 生成,
 * **请勿手工编辑**;对方新增表情后重跑该脚本即可。生成时间:${new Date().toISOString().slice(0, 10)}。
 *
 * 覆盖的都是系统性命名差异(国旗 china→flag_china、血型 a_button_blood_type→a_button、
 * 变音符号 türkiye→flag_turkiye 等),NodeLoc 作为机场/VPS 社区国旗用得很频繁,不能漏。
 */
export const EXTRA_EMOJI_MAP: Record<string, string> = {
${body}
}
`

  const out = path.join(import.meta.dirname, '..', '..', 'services', 'import', 'emoji-extra-map.ts')
  await writeFile(out, file)

  console.log(`[emoji-extra] 生成 ${entries.length} 条兜底映射 → services/import/emoji-extra-map.ts`)
  if (unresolved.length) {
    // 仍解析不到的会在清洗时原样保留 `:name:`,不会变成乱码,仅作提示
    console.warn(`[emoji-extra] 仍未解析 ${unresolved.length} 个:${unresolved.join(' ')}`)
  }
}

await main()
