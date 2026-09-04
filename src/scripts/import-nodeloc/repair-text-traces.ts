/**
 * 回修脚本:清掉已落库**正文与标题里的文案痕迹**(§11.1 + §11.2)。
 *
 * 与 repair-image-urls.ts 的分工(**两者的作用域刻意不重叠,别合并**):
 * - 那个脚本管**图片地址**(把源站图链换成本地相对路径);
 * - 本脚本管**人类可读的文字**,且**一个字符都不碰 URL**(见下面的 maskUrls)。
 *   正文里含源站域名的地方绝大多数是图片链接 —— 实测 posts 1176 / comments 1503 行含
 *   `nodeloc` 字样,剔除 URL 后纯文本提及只剩 posts 130 / comments 307。若本脚本去改 URL,
 *   会把图片回修的候选正则打乱(它靠「仍含源站地址」框定候选行),两个流程互相拆台。
 *
 * ## 两类痕迹
 * 1. **placeholder**(§11.1,P0):早期清洗器给 `[poll]/[lottery]/[event]` 插件块生成的占位
 *    文案含「导入」二字,等于向每个读者宣告该帖是搬来的。代码已改中立措辞,但 **Node 不热更新、
 *    存量正文不会自愈** —— 新旧文案的对齐关系直接读 clean-markdown.ts 导出的
 *    `PLUGIN_BLOCK_PLACEHOLDERS`,避免两处各写一份字面量而对不上。
 * 2. **mention**(§11.2):正文/标题里作者手写的源站名(「nodeloc 什么时候出信息流」这类)。
 *    换成本站名。⚠️ 这是**改写他人原文**,用户已在知情前提下拍板要改(快照 §13 决定 2),
 *    但仍有语义会走形的边缘情形(如「NodeLoc(Discourse)的语言显示」——本站并非 Discourse),
 *    因此凡命中风险标记的行都会进人工复核清单,见 RISK_MARKERS。
 *
 * ## 用法
 * ```bash
 * cd server
 * pnpm tsx src/scripts/import-nodeloc/repair-text-traces.ts                  # 默认 dry-run,只报不改
 * pnpm tsx src/scripts/import-nodeloc/repair-text-traces.ts --kind mention   # 只看某一类
 * pnpm tsx src/scripts/import-nodeloc/repair-text-traces.ts --sample 15      # 多打几条改写前后对照
 * pnpm tsx src/scripts/import-nodeloc/repair-text-traces.ts --apply          # 真正写库
 * ```
 *
 * ## 设计要点
 * - **默认 dry-run**:不给 `--apply` 绝不写库。
 * - **幂等**:替换后的文本不再含任何匹配词 → 重跑命中 0 行。可反复执行。
 * - **代码块内不动**:围栏/行内代码里的域名往往是可执行命令或配置(`curl https://...`),
 *   改了会把别人的命令改坏。这类残留单独计数上报,由人决定要不要处理。
 * - **不写库时不产生任何副作用**,可以在回填进程还在跑的时候安全执行(只读查询)。
 * - 不联网:纯文本变换,没有任何源站请求 —— 因此**不受回填限速冲突的约束**。
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { prisma } from '../../lib/prisma.js'
import { PLUGIN_BLOCK_PLACEHOLDERS } from '../../services/import/clean-markdown.js'

/**
 * 本站展示名,替换源站名时用。
 *
 * @remarks 与 `client/nuxt.config.ts` 的 `head.title` 保持一致(当前 'AI Base')。
 *   服务端目前没有站点名常量,故在此就近定义;若将来 server 侧引入统一品牌常量,改为从那里取。
 */
const SITE_NAME = 'AI Base'

/**
 * 源站名的匹配形态。只收**足够独特**的写法。
 *
 * ⚠️ 刻意**不收裸 `NL`**:那两个字母在正常中文正文里到处都是(型号、缩写、变量名),
 *   一律替换会造成大面积误伤,收益远小于风险。
 */
const MENTION_RE = /nodeloc|NL社区|NL论坛/gi

/**
 * 人工复核风险标记:命中这些词说明该行的源站名与「具体产品事实」绑定,
 * 直接换成本站名会产出事实错误(本站没有 App、也不是 Discourse)。
 * 仍然替换(用户决策),但会写进复核清单供抽查。
 *
 * @remarks 刻意**不含** `.com` / `.net`:URL 已被遮罩、不会被改写,拿域名当风险标记
 *   只会把所有带图的行全标成待复核(实测 146 行虚高),清单就废了。
 */
const RISK_MARKERS = ['discourse', 'app', 'apk', 'mcp', 'api', '官方', '论坛']

/** 一条待改记录 */
interface Candidate {
  /** 数据表 */
  table: 'posts' | 'comments'
  /** 主键 */
  id: number
  /** 字段名 */
  field: 'title' | 'content'
  /** 改写前 */
  before: string
  /** 改写后 */
  after: string
  /** 首个改动字符的下标(对照片段与风险判定都锚在这里) */
  diffAt: number
  /** 是否命中风险标记,需人工复核 */
  risky: boolean
}

/** 围栏代码块与行内代码(与 clean-markdown 同口径) */
const CODE_SPAN_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g

/**
 * 需要整体遮罩、**一个字符都不能改**的三类目标,按顺序应用:
 *
 * 1. markdown 链接/图片的**目标地址** `](...)` —— 最外层的护栏。不论目标是绝对 URL、
 *    根相对路径还是锚点,都不许动;
 * 2. 裸的绝对 URL(没写成 markdown 链接、直接贴在正文里的);
 * 3. 剩下的 `/uploads/...` **根相对路径**。
 *
 * ⚠️ 第 1、3 条是 dry-run 实测补上的,不是防御性编程:只遮 `https?://` 时,
 * `![x](/uploads/nodeloc/abc.gif)` 里的目录名会被当成正文里的源站名替换掉,
 * 变成 `/uploads/AI Base/abc.gif` —— **所有已本地化的图片路径会被写坏且带空格**。
 * 那个目录名确实要改(§11.2 `nodeloc` → `legacy`),但那是一次 `mv` 加三条 UPDATE 的事,
 * 由收尾流水线第 1 步统一做,**绝不能由文案脚本顺手改**。
 */
/**
 * ⚠️ 三条正则的字符类都**必须排除本文件用作定界符的 U+E000 / U+E001 这两个码位**,
 * 否则前一条遮罩产出的占位符会被后一条正则当成 URL 的一部分吞掉,形成**嵌套占位**。
 * 实测样本 posts#36 的 `[https://x.html](https://x.html)`:第 1 条先把 `](https://x.html)`
 * 换成占位符,第 2 条的 URL 字符类若不排除定界符,就会把裸 URL 连同紧跟的整个占位符一起吞走。
 * 而 `String.replace` **不会重扫替换结果**,单次还原修不回内层占位符 ——
 * 占位符就会原样写进用户正文(初版 dry-run 实测漏出过)。
 *
 * ⚠️ 但**只能排除这两个码位,不能排除整个私有使用区**:实测存量正文里本来就带私有区字符
 * (作者从 ChatGPT 复制正文时带进来的引用标记 `citeturn1file1`,U+E200 段)。
 * 按整区排除会让这些历史字符落进遮罩边界、并让下方残留守卫把**别人原文里的字符**
 * 误判成我方占位符残留、整轮抛错中止。那些字符不是本脚本的职责,原样放过。
 */
const MASK_PATTERNS: RegExp[] = [
  /\]\([^)\s\uE000\uE001]*\)/g,
  /https?:\/\/[^\s)"'<>\]\uE000\uE001]+/g,
  /\/uploads\/[^\s)"'<>\]\uE000\uE001]+/g,
]

/**
 * 把代码段与上述地址挖空 → 执行 transform → 填回原文。
 *
 * 用 U+E001 私有区字符做占位(clean-markdown 用的是 U+E000,**刻意错开**,
 * 避免两套遮罩在同一段文本上先后运行时互相吃掉占位符)。
 */
function transformProseOnly(text: string, transform: (s: string) => string): string {
  const vault: string[] = []
  const stash = (whole: string): string => `\uE001M${vault.push(whole) - 1}\uE001`
  let masked = text.replace(CODE_SPAN_RE, stash)
  for (const re of MASK_PATTERNS) masked = masked.replace(re, stash)
  const restored = transform(masked).replace(/\uE001M(\d+)\uE001/g, (whole, i) => vault[Number(i)] ?? whole)
  // 宁可整轮抛错中止,也不能把占位符写进任何人的正文 —— 那是不可逆的正文损坏
  const residue = restored.search(/[\uE000\uE001]/)
  if (residue >= 0) {
    throw new Error(
      `遮罩还原不完整,残留占位符定界符。片段:${restored.slice(Math.max(0, residue - 60), residue + 60)}`,
    )
  }
  return restored
}

/** 把 legacy 占位文案对齐到 current(§11.1) */
function fixPlaceholders(text: string): string {
  let out = text
  for (const { legacy, current } of Object.values(PLUGIN_BLOCK_PLACEHOLDERS)) {
    out = out.split(legacy).join(current)
  }
  return out
}

/** 替换纯文本里的源站名(§11.2);URL 与代码由调用方遮罩后传入 */
function fixMentions(text: string): string {
  return text.replace(MENTION_RE, SITE_NAME)
}

/** 判定一段文本的上下文是否需要人工复核 */
function isRisky(text: string): boolean {
  const lower = text.toLowerCase()
  return RISK_MARKERS.some((m) => lower.includes(m))
}

/** 对单个字段值算出改写结果;无变化返回 null */
function rewrite(value: string, kinds: Set<'placeholder' | 'mention'>): string | null {
  let out = value
  if (kinds.has('placeholder')) out = fixPlaceholders(out)
  if (kinds.has('mention')) out = transformProseOnly(out, fixMentions)
  return out === value ? null : out
}

/**
 * 新旧文本**首个不同字符**的下标。
 *
 * 对照片段必须锚在这里,而不是锚在「第一次出现源站名的位置」:后者往往落在一条被遮罩的
 * 图片 URL 上(正文里的源站名绝大多数是图链),于是 dry-run 打出来的旧/新两行看起来
 * 完全一样、真正的改动在几百字符之外 —— 输出会骗人,等于没有 dry-run。
 */
function firstDiffAt(before: string, after: string): number {
  const len = Math.min(before.length, after.length)
  for (let i = 0; i < len; i++) if (before[i] !== after[i]) return i
  return len
}

/** 取 text 在 at 附近的上下文片段(换行折成 ⏎,便于单行打印) */
function windowAt(text: string, at: number, radius = 45): string {
  return text.slice(Math.max(0, at - radius), at + radius).replace(/\n/g, '⏎')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const kindArg = argv[argv.indexOf('--kind') + 1]
  const sampleSize = Number(argv[argv.indexOf('--sample') + 1]) || 6
  const kinds = new Set<'placeholder' | 'mention'>(
    !argv.includes('--kind') || kindArg === 'all'
      ? (['placeholder', 'mention'] as const)
      : ([kindArg] as ('placeholder' | 'mention')[]),
  )
  if ([...kinds].some((k) => k !== 'placeholder' && k !== 'mention')) {
    throw new Error(`--kind 只能是 placeholder | mention | all,收到:${kindArg}`)
  }

  console.log(`[repair-text-traces] 模式=${apply ? 'APPLY(写库)' : 'DRY-RUN(只读)'} 类别=${[...kinds].join(',')}`)

  // 候选行用宽口径 SQL 框定(宁可多取、由 JS 精算),避免把 SQL 正则写成第二套真理
  const legacyLike = Object.values(PLUGIN_BLOCK_PLACEHOLDERS).map((p) => p.legacy)
  const candidates: Candidate[] = []

  const posts = await prisma.post.findMany({
    where: {
      OR: [
        ...(kinds.has('mention')
          ? [
              { content: { contains: 'odeloc', mode: 'insensitive' as const } },
              { title: { contains: 'odeloc', mode: 'insensitive' as const } },
              { content: { contains: 'NL社区' } },
              { title: { contains: 'NL社区' } },
              { content: { contains: 'NL论坛' } },
              { title: { contains: 'NL论坛' } },
            ]
          : []),
        ...(kinds.has('placeholder') ? legacyLike.map((s) => ({ content: { contains: s } })) : []),
      ],
    },
    select: { id: true, title: true, content: true },
  })
  for (const p of posts) {
    for (const field of ['title', 'content'] as const) {
      const after = rewrite(p[field], kinds)
      if (after === null) continue
      const diffAt = firstDiffAt(p[field], after)
      candidates.push({
        table: 'posts',
        id: p.id,
        field,
        before: p[field],
        after,
        diffAt,
        risky: isRisky(windowAt(after, diffAt, 60)),
      })
    }
  }

  const comments = await prisma.comment.findMany({
    where: {
      OR: [
        ...(kinds.has('mention')
          ? [
              { content: { contains: 'odeloc', mode: 'insensitive' as const } },
              { content: { contains: 'NL社区' } },
              { content: { contains: 'NL论坛' } },
            ]
          : []),
        ...(kinds.has('placeholder') ? legacyLike.map((s) => ({ content: { contains: s } })) : []),
      ],
    },
    select: { id: true, content: true },
  })
  for (const c of comments) {
    const after = rewrite(c.content, kinds)
    if (after === null) continue
    const diffAt = firstDiffAt(c.content, after)
    candidates.push({
      table: 'comments',
      id: c.id,
      field: 'content',
      before: c.content,
      after,
      diffAt,
      risky: isRisky(windowAt(after, diffAt, 60)),
    })
  }

  // 只在代码块/URL 里残留、正文无痕的行:本脚本刻意不动,单独计数让人知道它们存在
  const untouchedRows = posts.length + comments.length - candidates.length

  const byTable = (t: string, f: string): number =>
    candidates.filter((c) => c.table === t && c.field === f).length
  console.log(
    [
      `  posts.title   命中 ${byTable('posts', 'title')} 行`,
      `  posts.content 命中 ${byTable('posts', 'content')} 行`,
      `  comments      命中 ${byTable('comments', 'content')} 行`,
      `  需人工复核(含 App/Discourse/域名等事实性表述) ${candidates.filter((c) => c.risky).length} 行`,
      `  取到但无需改写(痕迹只存在于代码块或 URL 内,刻意不动) ${untouchedRows} 行`,
    ].join('\n'),
  )

  console.log(`\n--- 改写前后对照(前 ${sampleSize} 条) ---`)
  for (const c of candidates.slice(0, sampleSize)) {
    console.log(`[${c.table}#${c.id}.${c.field}]${c.risky ? ' ⚠️需复核' : ''}`)
    console.log(`  旧: ${windowAt(c.before, c.diffAt)}`)
    console.log(`  新: ${windowAt(c.after, c.diffAt)}`)
  }

  const reviewFile = path.resolve(process.cwd(), '.repair-text-review.md')
  writeFileSync(
    reviewFile,
    [
      `# 文案回修人工复核清单(${new Date().toISOString()})`,
      '',
      `本站名替换为 \`${SITE_NAME}\`。下列行的原文把源站名与具体产品事实绑在一起,`,
      '机械替换会产出事实错误(本站没有 App、也不是 Discourse),需抽查决定是否单独改写或删句。',
      '',
      ...candidates
        .filter((c) => c.risky)
        .map((c) => `- \`${c.table}#${c.id}.${c.field}\`: ${windowAt(c.after, c.diffAt, 70)}`),
    ].join('\n'),
    'utf8',
  )
  console.log(`\n复核清单已写入 ${reviewFile}`)

  if (!apply) {
    console.log('\nDRY-RUN 结束,未写库。确认无误后加 --apply。')
    return
  }

  let written = 0
  for (const c of candidates) {
    if (c.table === 'posts') {
      await prisma.post.update({
        where: { id: c.id },
        data: c.field === 'title' ? { title: c.after } : { content: c.after },
      })
    } else {
      await prisma.comment.update({ where: { id: c.id }, data: { content: c.after } })
    }
    written++
  }
  console.log(`\nAPPLY 完成,写入 ${written} 行。重跑本脚本应命中 0 行(幂等自检)。`)
}

main()
  .catch((err) => {
    console.error('[repair-text-traces] 失败', err)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
