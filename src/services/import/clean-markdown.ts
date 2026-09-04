import { createRequire } from 'node:module'
import * as nodeEmoji from 'node-emoji'
import { EXTRA_EMOJI_MAP } from './emoji-extra-map.js'
import { CUSTOM_STICKER_FILES } from './sticker-manifest.js'

/**
 * Discourse raw Markdown 清洗器(纯函数,无 IO)。
 * 规则来源:计划文件「一、表情/评论/图片的复刻方案」:
 * - :shortcode: 表情 → 标准的替换为 Unicode 字符,自定义的重写为我方贴图语法 ![name](/stickers/file)
 * - upload://base62 伪协议 → 按调用方传入的映射重写为本地/远程真实 URL(|WxH 尺寸后缀剥掉,Discourse 私有语法)
 * - [quote=...]...[/quote] → blockquote + 回复 @user: 前缀
 * - [poll]/[lottery]/[event] 插件块 → 占位文案;[details] → 保留内容
 * - 代码块(围栏/行内)内的文本不做任何替换
 */

// unicode-emoji-json 主导出是 JSON(按 emoji 字符为 key,含 CLDR slug)。
// NodeNext ESM 直接 import JSON 需要 import attributes,这里用 createRequire 更稳。
const require = createRequire(import.meta.url)
const dataByEmoji = require('unicode-emoji-json') as Record<string, { slug: string }>

/** CLDR slug(如 grinning_face)→ emoji 字符,补齐 node-emoji(gemoji 命名)覆盖不到的部分 */
const emojiBySlug = new Map<string, string>()
for (const [char, meta] of Object.entries(dataByEmoji)) {
  if (!emojiBySlug.has(meta.slug)) emojiBySlug.set(meta.slug, char)
}

/** 清洗上下文:图片 URL 重写映射(由图片管道预先构建) */
export interface CleanContext {
  /** upload:// base62 token(不含扩展名)→ 重写后的图片 URL(本地相对路径或远程兜底) */
  uploadUrlByToken: Map<string, string>
  /** 远程图片 URL(nodeloc uploads 直链)→ 本地相对路径 */
  localUrlByRemote: Map<string, string>
}

/** 提取 raw 中的全部 upload:// token(不含扩展名),供图片管道解析 */
export function extractUploadTokens(raw: string): string[] {
  const tokens = new Set<string>()
  for (const m of raw.matchAll(/upload:\/\/([a-zA-Z0-9]+)(?:\.[a-zA-Z0-9]+)?/g)) {
    tokens.add(m[1]!)
  }
  return [...tokens]
}

/** 提取 raw 中的 NodeLoc uploads 直链图片 URL,供图片管道下载 */
export function extractRemoteUploadUrls(raw: string): string[] {
  const urls = new Set<string>()
  for (const m of raw.matchAll(/https?:\/\/(?:www\.)?nodeloc\.com\/uploads\/[^\s)"'<>\]]+/g)) {
    urls.add(m[0])
  }
  return [...urls]
}

/**
 * 从 NodeLoc uploads 直链里反解图片 sha1。
 *
 * 正文直链实测只有一种形态:`/uploads/default/{40 位 sha1}`(无扩展名、无 3X 分片路径),
 * 而这种形态源站**直接 404**(2026-09-03 抽查 3/3 全 404)。真实可下载地址只存在于
 * cooked 的 `<img src>` 里(见 buildSha1UrlMap),两边靠这 40 位 sha1 对齐。
 *
 * @param url 正文里出现的 uploads 直链
 * @returns 40 位小写 sha1;不是裸 sha1 形态(如已是 3X 分片真实地址)返回 null
 */
export function parseBareUploadSha1(url: string): string | null {
  return /\/uploads\/(?:[^/]+\/)?([0-9a-f]{40})(?:\.[a-zA-Z0-9]+)?$/.exec(url)?.[1] ?? null
}

/**
 * 从**任意** uploads 地址反解 sha1:裸形态 `/uploads/default/{sha1}` 与分片真实形态
 * `/uploads/default/original/3X/8/c/{sha1}.png`(含 `_2_500x500` 尺寸后缀)都认。
 *
 * 与 parseBareUploadSha1 的分工:那个只认「裸 = 源站 404」形态,用于判定某地址是否不可下载;
 * 这个用于「拿到 sha1 好去 cooked 里找同图的 original/optimized 候选」,
 * 所以对已经是分片地址的输入也要给出 sha1(否则 token 图片拿不到原图优先与超限降级)。
 */
export function parseUploadSha1(url: string): string | null {
  return /\/uploads\/[^?#]*?([0-9a-f]{40})/.exec(url)?.[1] ?? null
}

/** cooked 里同一张图可能同时给出原图与压缩图两种地址 */
export interface Sha1ImageSources {
  /** `/uploads/.../original/...` 原图地址(画质优先) */
  original?: string
  /** `/uploads/.../optimized/..._2_WxH.jpeg` 压缩图地址(原图超 MAX_IMAGE_BYTES 时降级用) */
  optimized?: string
}

/**
 * cooked 里的真实上传路径:`/uploads/{站点}/{optimized|original}/3X/{分片}/{sha1}{尺寸后缀}.{ext}`。
 * 捕获组 1 = optimized|original,组 2 = 40 位 sha1。
 */
const COOKED_UPLOAD_PATH_RE =
  /\/uploads\/[^/"'\s]+\/(optimized|original)\/\d+X\/(?:[0-9a-f]\/)+([0-9a-f]{40})[^"'\s>)]*/g

/**
 * 从 cooked HTML 建 sha1 → 真实图片地址映射。
 *
 * 与 buildRemoteUrlMap 的分工:那个按 `data-base62-sha1` 属性建索引,只能覆盖带 token 的 `<img>`;
 * 实测同一楼里近半 `<img>` 根本没有该属性(帖 106355:4 张图只有 2 张带),
 * 且正文直链是裸 sha1 形态、源站 404 —— 只认 token 的映射在结构上就是漏的。
 * 这里不依赖任何属性,直接从 src/href 的上传路径反解 sha1,与正文裸链同源可对齐换址。
 */
export function buildSha1UrlMap(cooked: string): Map<string, Sha1ImageSources> {
  const map = new Map<string, Sha1ImageSources>()
  for (const m of cooked.matchAll(COOKED_UPLOAD_PATH_RE)) {
    const kind = m[1] as keyof Sha1ImageSources
    const sha1 = m[2]!
    const entry = map.get(sha1) ?? {}
    // 同一 kind 只留首个:同图在 cooked 中多次出现时地址一致,重复覆盖无意义
    if (!entry[kind]) entry[kind] = m[0]
    map.set(sha1, entry)
  }
  return map
}

/**
 * 从 cooked HTML 提取 upload token → 远程真实 URL 的映射。
 * Discourse cooked 里 <img> 带 data-base62-sha1 属性,src 是已解析的真实地址;
 * lightbox 包裹时 <a class="lightbox" href> 是原图,优先级更高。
 *
 * ⚠️ 取 lightbox 的 href 必须用 `\shref="` 锚定(前置空白),不能写 `[^>]+href="`:
 * lightbox 锚点上还有个 `data-download-href="/uploads/default/{sha1}"`(**无分片裸地址,源站恒 404**),
 * 贪婪的 `[^>]+` 会回溯到最后一个 `href="` 上,正好落在 `data-download-href` 里,
 * 于是把 token 映射成 404 地址、还覆盖掉上一轮 `<img src>` 拿到的正确地址。
 * 2026-09-03 实测:主题 105140 的图片就是这样被写成死链的(且全程无 warn,见 import-images)。
 */
export function buildRemoteUrlMap(cooked: string): Map<string, string> {
  const map = new Map<string, string>()
  // img 标签:src 与 data-base62-sha1 成对出现(属性顺序不定,分两个方向匹配)
  for (const m of cooked.matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0]
    const token = /data-base62-sha1="([a-zA-Z0-9]+)"/.exec(tag)?.[1]
    const src = /\bsrc="([^"]+)"/.exec(tag)?.[1]
    if (token && src) map.set(token, src)
  }
  // lightbox 原图优先:锚点 href 紧邻内部 img 的 token
  for (const m of cooked.matchAll(
    /<a[^>]*class="lightbox"[^>]*\shref="([^"]+)"[^>]*>[\s\S]*?data-base62-sha1="([a-zA-Z0-9]+)"/g,
  )) {
    const href = m[1]!
    // 再兜一层:只有分片真实地址才允许覆盖 <img src>,裸 sha1 地址(404 形态)一律不采用
    if (parseBareUploadSha1(href)) continue
    map.set(m[2]!, href)
  }
  return map
}

/** 围栏代码块与行内代码 */
const CODE_SPAN_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g

/**
 * 代码占位符。用 U+E000(私有区) 包裹的理由:
 * - Discourse raw 里不可能出现(Unicode 私有使用区,无字形、无输入法),不必担心与正文冲突
 * - 不被本文件任何转换正则命中(表情的 `\p{L}\p{N}` 类、BBCode 的 `[^\]]` 类都不含它)
 */
const CODE_PLACEHOLDER_RE = /(^[^\S\n]*(?:>[^\S\n]*)+)?\uE000C(\d+)\uE000/gm

/**
 * 把 markdown 文本里的代码挖空后应用 transform,再填回去:代码内容一个字符都不变。
 *
 * ⚠️ 这里**不能**用「按代码块切段、只转换非代码段」的写法(2026-09-03 前的实现就是那样),
 * 那样做的话跨代码的**块级 BBCode 配不上对**:开标签与闭标签一旦被中间任何一段行内代码
 * 或围栏代码隔开,就落进两个不同 segment,`[\s\S]*?` 再宽也跨不过去,于是标签原样漏进正文。
 * 实测帖 212(6 组 `[details="NodeLoc App vX.Y.Z"]`)与帖 306 就是这么漏的 —— 它们的
 * 折叠块正文里全是 `` `代码` ``,首尾标签必然分家。`[quote]`/`[spoiler]`/`[poll]` 同理。
 */
function transformOutsideCode(text: string, transform: (segment: string) => string): string {
  const blocks: string[] = []
  const masked = text.replace(CODE_SPAN_RE, (whole) => `\uE000C${blocks.push(whole) - 1}\uE000`)
  return transform(masked).replace(CODE_PLACEHOLDER_RE, (whole, prefix: string | undefined, i) => {
    const body = blocks[Number(i)]
    if (body === undefined) return whole
    if (!prefix) return body
    // 围栏块被 replaceQuotes 的行首 `> ` 收进引用时,占位符是单行、只有首行拿到前缀;
    // 填回多行后必须给其余行补上,否则裸的 ``` 行会提前把 blockquote 截断。
    return prefix + body.split('\n').join(`\n${prefix}`)
  })
}

/** :shortcode: 替换(含肤色后缀 :name:t2: 剥离);查不到映射保留原文 */
function replaceEmojis(segment: string): string {
  // 字符类必须含 \p{L}:对方词表里有 türkiye / curaçao / piñata 这类带变音符号的 shortcode,
  // 只写 [a-z0-9_+-] 的话正则根本匹配不到,兜底表再全也用不上。
  // 放宽不会误伤:查不到映射的一律原样保留(如中文冒号夹词、`时间:12:30`)。
  return segment.replace(/:([\p{L}\p{N}_+-]+)(?::t[1-6])?:/giu, (whole, name: string) => {
    const sticker = CUSTOM_STICKER_FILES[name]
    if (sticker) return `![${name}](/stickers/${sticker}) `
    const byGemoji = nodeEmoji.get(name)
    if (byGemoji) return byGemoji
    const bySlug = emojiBySlug.get(name.toLowerCase())
    if (bySlug) return bySlug
    // 第三级:两套词表的系统性命名差异兜底(国旗 china、血型 a_button_blood_type、
    // 变音符号 türkiye 等 39 个),生成器见 scripts/import-nodeloc/build-emoji-extra-map.ts
    const extra = EXTRA_EMOJI_MAP[name.toLowerCase()]
    if (extra) return extra
    return whole
  })
}

/** [quote="user, post:N, ..."]...[/quote] → blockquote,由内向外循环处理嵌套 */
function replaceQuotes(text: string): string {
  const innermost = /\[quote(?:=(?:"([^"\]]*)"|([^\]]*)))?\]((?:(?!\[quote)[\s\S])*?)\[\/quote\]/i
  let out = text
  for (let guard = 0; guard < 20; guard++) {
    const m = innermost.exec(out)
    if (!m) break
    const attr = m[1] ?? m[2] ?? ''
    const username = attr.split(',')[0]?.trim()
    const body = (m[3] ?? '').trim()
    const quoted = body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    const header = username ? `> **回复 @${username}:**\n` : ''
    out = out.slice(0, m.index) + `\n${header}${quoted}\n` + out.slice(m.index + m[0].length)
  }
  return out
}

/**
 * 插件块占位文案的「历史值 → 当前值」映射。
 *
 * 为什么要把文案抽成常量、还留着历史值:
 * - 这些字符串会**落进正文并被读者看到**,措辞属产品面,不能散落在正则里;
 * - 早期措辞含「导入」二字,等于向每个读者宣告该帖是搬来的(用户已在前台看到并反馈)。
 *   现措辞一律中立:**不得出现 导入 / 迁移 / 原站 / 搬运 / 同步 任何一词**;
 * - 代码改了只影响之后新清洗的内容,**存量正文不会自愈**,需要一轮回修
 *   (`scripts/import-nodeloc/repair-text-traces.ts`)。回修脚本直接读本常量对齐替换,
 *   避免两处各写一份字面量而对不上(改文案时只需改这里)。
 *
 * @remarks `legacy` 是需要被替换掉的旧文案,`current` 是现行文案。
 */
export const PLUGIN_BLOCK_PLACEHOLDERS: Record<
  /** 插件块类型,与 BBCode 标签名一致 */
  'poll' | 'lottery' | 'event',
  {
    /** 历史文案(存量正文里可能残留,回修脚本的匹配目标) */
    legacy: string
    /** 现行中立文案 */
    current: string
  }
> = {
  poll: { legacy: '📊 此处原为投票,导入内容不支持互动', current: '📊 投票内容暂不支持展示' },
  lottery: {
    legacy: '🎁 此处原为抽奖活动,导入内容不支持互动',
    current: '🎁 抽奖活动内容暂不支持展示',
  },
  event: {
    legacy: '📅 此处原为日历活动,导入内容不支持互动',
    current: '📅 日历活动内容暂不支持展示',
  },
}

/** 拼成引用块形态(与替换前的块级语义一致:前后各留一个换行) */
const placeholderOf = (kind: keyof typeof PLUGIN_BLOCK_PLACEHOLDERS): string =>
  `\n> ${PLUGIN_BLOCK_PLACEHOLDERS[kind].current}\n`

/** Discourse 插件块(投票/抽奖/日历活动)→ 占位文案;[details]/[grid]/[spoiler] → 保留正文 */
function replacePluginBlocks(text: string): string {
  const withPlugins = text
    .replace(/\[poll\b[^\]]*\][\s\S]*?\[\/poll\]/gi, placeholderOf('poll'))
    .replace(/\[lottery\b[^\]]*\][\s\S]*?\[\/lottery\]/gi, placeholderOf('lottery'))
    .replace(/\[event\b[^\]]*\][\s\S]*?\[\/event\]/gi, placeholderOf('event'))
    .replace(/\[wrap=[^\]]*\]([\s\S]*?)\[\/wrap\]/gi, '$1')
    // [grid] 是 Discourse 图集布局插件,我方无对应组件 → 直接解包,图片退化为顺序排列
    .replace(/\[grid\b[^\]]*\]([\s\S]*?)\[\/grid\]/gi, '$1')
    // [spoiler] 原意是遮挡(实测里面装 Base64 / API key)。**不能解包成明文**,否则等于我方
    // 替原作者公开;转成 <details> 保留「默认折叠、点击才展开」语义。
    // <details>/<summary> 在 DOMPurify 默认白名单内;标签与正文间的空行必须保留,
    // 否则 marked 不把内部当 Markdown 渲染(会整块当 HTML 原样吐出)。
    .replace(
      /\[spoiler\b[^\]]*\]([\s\S]*?)\[\/spoiler\]/gi,
      (_w, body: string) =>
        `\n\n<details><summary>剧透内容(点击展开)</summary>\n\n${body.trim()}\n\n</details>\n\n`,
    )
  const unpacked = replaceDetails(withPlugins)
  return unpacked
}

/**
 * `[details]` / `[details="标题"]` → **标题** + 正文(折叠语义丢弃,内容一律展开保留)。
 *
 * 两处比朴素 `.replace` 讲究的地方:
 * - 参数是**可选**的:实测大多带 `="..."`(帖 212 的 `[details="NodeLoc App v0.3.2"]`),
 *   但 Discourse 也允许裸 `[details]`,旧实现的正则把 `=` 写成必需,裸形态直接漏网
 * - 由内向外循环(与 replaceQuotes 同一手法):`[\s\S]*?` 非贪婪遇到**嵌套**折叠块时会把
 *   「外层开标签 … 内层闭标签」当成一对,剩下的外层闭标签就成了漏进正文的裸标签
 */
function replaceDetails(text: string): string {
  const innermost =
    /\[details(?:=(?:"([^"\]]*)"|([^\]]*)))?\]((?:(?!\[details)[\s\S])*?)\[\/details\]/i
  let out = text
  for (let guard = 0; guard < 20; guard++) {
    const m = innermost.exec(out)
    if (!m) break
    const summary = (m[1] ?? m[2] ?? '').trim()
    const body = (m[3] ?? '').trim()
    out =
      out.slice(0, m.index) +
      `\n${summary ? `**${summary}**\n\n` : ''}${body}\n` +
      out.slice(m.index + m[0].length)
  }
  return out
}

/**
 * 图片重写:
 * - ![alt|WxH](upload://token.ext) → ![alt](映射 URL),|WxH 尺寸后缀是 Discourse 私有语法必须剥掉
 * - 正文里的 nodeloc uploads 直链 → 本地相对路径(若已下载)
 * 映射缺失时兜底为 NodeLoc 原站绝对地址(实测无防盗链),不产出裂图。
 */
function replaceImages(text: string, ctx: CleanContext): string {
  let out = text.replace(
    /!\[([^\]|]*)(?:\|[^\]]*)?\]\(upload:\/\/([a-zA-Z0-9]+)(\.[a-zA-Z0-9]+)?\)/g,
    (_whole, alt: string, token: string) => {
      const url = ctx.uploadUrlByToken.get(token)
      if (!url) return `![${alt}](https://www.nodeloc.com/404-${token})`
      return `![${alt}](${url})`
    },
  )
  for (const [remote, local] of ctx.localUrlByRemote) {
    out = out.split(remote).join(local)
  }
  return out
}

/** 清洗入口:对一楼/评论的 raw Markdown 做全部转换,产物可直接过我方 marked+DOMPurify 渲染链 */
export function cleanMarkdown(raw: string, ctx: CleanContext): string {
  let text = raw
  text = transformOutsideCode(text, (seg) => replaceQuotes(replacePluginBlocks(seg)))
  text = replaceImages(text, ctx)
  text = transformOutsideCode(text, replaceEmojis)
  return text.trim()
}
