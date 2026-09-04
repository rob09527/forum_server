/**
 * 回修脚本:把已落库正文里的**死图链**换成本地图片地址。
 *
 * 背景:导入器早期版本对正文里的 `https://www.nodeloc.com/uploads/default/{40 位 sha1}`
 * 直链是「直接下载」的,而这种裸 sha1 形态**源站恒 404**(2026-09-03 实测)。
 * 真实可下载地址只存在于 cooked 的 `<img src>` 里(`/uploads/default/original/3X/e/5/{sha1}.jpeg`),
 * 两边靠 40 位 sha1 对齐。修复口径已内置进 import-images.ts 的 downloadUploadUrl,
 * 本脚本负责回补「用旧代码导进来的存量数据」。
 *
 * 顺带修复 `https://www.nodeloc.com/404-{token}` 占位地址:那是 upload:// token 在 cooked 里
 * 找不到映射时的兜底假 URL,必然裂图;本脚本重抓 cooked 后按 token 补上真实地址。
 *
 * 第三类(§9.3 C 类)是 `uploads/{站点}/{original|optimized}/3X/.../{sha1}.{ext}`:
 * 这类地址**源站真能下载**,只是当年直接把源站地址写进了正文、没本地化 —— 图挂在别人服务器上,
 * 对方删图/防盗链就裂,所以一并落地换址(实测 4 处,其中 1 处是 `.mp3` 附件已按扩展名排除)。
 *
 * ## 用法
 * ```bash
 * cd server
 * pnpm tsx src/scripts/import-nodeloc/repair-image-urls.ts              # 默认 dry-run,只报不改
 * pnpm tsx src/scripts/import-nodeloc/repair-image-urls.ts --limit 20   # 只处理前 20 个主题(试水)
 * pnpm tsx src/scripts/import-nodeloc/repair-image-urls.ts --apply      # 真正写库
 * pnpm tsx src/scripts/import-nodeloc/repair-image-urls.ts --apply --restart  # 忽略断点重头跑
 * ```
 *
 * ## 设计要点
 * - **默认 dry-run**:不给 `--apply` 绝不写库,只打印将要改什么、影响多少行、预计请求数与耗时。
 * - **幂等**:候选行由 SQL 正则框定(只有仍含 A/B/C 三类源站地址的行才进来),
 *   修完后正文里写的是本地 `/uploads/{子目录}/...` 相对路径,不再命中候选正则 → 重跑不会反复重写。
 *   图片落盘也幂等(downloadOne 按 sha1 前 16 位探测已存在文件)。
 * - **断点续跑**:按源主题分批,每批后写 `.import-repair-checkpoint.json`(与回填的
 *   `.import-backfill-checkpoint.json` **不同名**,互不干扰)。1.3 万帖规模下必须能续。
 * - **限速**:所有源站请求走 nodeloc-client.ts 的串行节流(JSON 1100ms / 图片 350ms),
 *   本脚本不自己写 fetch,也不并行。
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { prisma } from '../../lib/prisma.js'
import { fetchNodelocJson } from '../../services/import/nodeloc-client.js'
import { buildTopicImageMaps, downloadUploadUrl } from '../../services/import/import-images.js'
import { IMPORT_SOURCE, NODELOC_BASE_URL } from '../../services/import/import-config.js'
import type { DiscoursePost, DiscoursePostsResponse } from '../../services/import/nodeloc-types.js'

/** 断点文件路径(**刻意与回填断点不同名**,避免两个流程互相覆盖) */
const CHECKPOINT_FILE = path.resolve(process.cwd(), '.import-repair-checkpoint.json')

/** 每处理多少个主题落一次断点(太密写盘浪费,太疏重跑代价大) */
const CHECKPOINT_EVERY = 10

/**
 * 允许本地化的图片扩展名(与 import-images.ts 的 ALLOWED_EXTS 同口径)。
 * **C 类候选必须按扩展名收窄**:源站同一路径形态下还挂着 mp3/zip 之类附件
 * (实测 comment#7083 是一条 `.mp3` 音频链接),那些 `downloadOne` 的 inferExt 认不出,
 * 抓了也只会返回 null 白打一次请求 —— 图片本地化不负责附件。
 */
const IMAGE_EXT_RE_SRC = '(?:png|jpe?g|gif|webp|avif|svg)'

/**
 * 候选行判定正则(SQL 侧与 JS 侧必须同口径),三类形态:
 * - A 裸 sha1 直链 `nodeloc.com/uploads/[default/]{40 hex}`(源站恒 404);
 * - B 假占位 `nodeloc.com/404-{token}`;
 * - C **真实可下载但没本地化**的 cooked 路径 `uploads/{站点}/{original|optimized}/3X/{分片}/{sha1}…{图片扩展名}`
 *   —— 这类不是死链,只是当年直接把源站地址写进了正文,必须落地换址(§9.3,实测 4 处,其中 1 处是附件已排除)。
 */
const BAD_URL_SQL_RE =
  'nodeloc\\.com/(?:uploads/(?:default/)?[0-9a-f]{40}|404-|uploads/[^/"\'\\s]+/(?:original|optimized)/[0-9]+X/(?:[0-9a-f]/)+[0-9a-f]{40}[A-Za-z0-9_.-]*\\.' +
  IMAGE_EXT_RE_SRC +
  ')'
/** JS 侧:提取正文里的裸 sha1 直链 */
const BARE_URL_RE = /https?:\/\/(?:www\.)?nodeloc\.com\/uploads\/(?:default\/)?[0-9a-f]{40}/g
/** JS 侧:提取正文里的 404 假占位地址,捕获组 1 = upload token */
const FAKE_404_RE = /https?:\/\/(?:www\.)?nodeloc\.com\/404-([a-zA-Z0-9]+)/g
/** JS 侧:提取 C 类真实 cooked 图片直链(口径与 BAD_URL_SQL_RE 第三段一致) */
const REAL_UPLOAD_URL_RE = new RegExp(
  'https?://(?:www\\.)?nodeloc\\.com/uploads/[^/"\'\\s]+/(?:original|optimized)/[0-9]+X/(?:[0-9a-f]/)+[0-9a-f]{40}[A-Za-z0-9_.-]*\\.' +
    IMAGE_EXT_RE_SRC,
  'g',
)

/** 一行正文里三类坏链的出现总数(dry-run 统计与耗时预估共用,口径必须只有一处) */
function countBadUrls(content: string): number {
  return (
    (content.match(BARE_URL_RE) ?? []).length +
    (content.match(FAKE_404_RE) ?? []).length +
    (content.match(REAL_UPLOAD_URL_RE) ?? []).length
  )
}

/** 实测限速常量,仅用于耗时预估 */
const JSON_INTERVAL_MS = 1100
const ASSET_INTERVAL_MS = 350

interface Checkpoint {
  /** 已处理完的源主题 id(升序);续跑时跳过 */
  doneTopicIds: number[]
  /** 累计统计,便于跨会话汇总 */
  stats: RepairStats
}

interface RepairStats {
  /** 已处理主题数 */
  topics: number
  /** 抓不到 cooked 的主题数(源站已删/登录可见) */
  topicsMissing: number
  /** 实际改写的 posts 行数 */
  postsUpdated: number
  /** 实际改写的 comments 行数 */
  commentsUpdated: number
  /** 成功换址并落盘的图片数 */
  imagesFixed: number
  /** 换址后仍下载失败的图片数(坏链原样留在正文) */
  imagesFailed: number
}

/** 一个待修行 */
interface Candidate {
  /** 行所属表 */
  kind: 'post' | 'comment'
  /** 本地行 id */
  id: number
  /** 源主题 id(决定抓哪个 topic 的 cooked) */
  sourceTopicId: number
  /** 源楼层 post id(决定抓哪些楼的 cooked) */
  sourcePostId: number
  /** 当前正文 */
  content: string
}

function parseArgs() {
  const argv = process.argv.slice(2)
  const limitIdx = argv.indexOf('--limit')
  return {
    apply: argv.includes('--apply'),
    restart: argv.includes('--restart'),
    limit: limitIdx >= 0 ? Number(argv[limitIdx + 1]) : Infinity,
  }
}

function loadCheckpoint(restart: boolean): Checkpoint {
  const empty: Checkpoint = {
    doneTopicIds: [],
    stats: {
      topics: 0,
      topicsMissing: 0,
      postsUpdated: 0,
      commentsUpdated: 0,
      imagesFixed: 0,
      imagesFailed: 0,
    },
  }
  if (restart) {
    if (existsSync(CHECKPOINT_FILE)) unlinkSync(CHECKPOINT_FILE)
    return empty
  }
  if (!existsSync(CHECKPOINT_FILE)) return empty
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf8')) as Checkpoint
  } catch {
    console.warn('[repair] 断点文件损坏,按空断点重头跑')
    return empty
  }
}

/**
 * 拉出全部候选行。
 * 用 SQL 正则先框定影响面(而不是全表逐行过清洗器):
 * 6739 条评论里只有 167 条命中,全表过一遍纯属浪费。
 */
async function loadCandidates(): Promise<Candidate[]> {
  const rows = await prisma.$queryRawUnsafe<
    { kind: string; id: number; sourceTopicId: number; sourcePostId: number; content: string }[]
  >(`
    SELECT 'post' AS kind, p.id, m."sourceTopicId", m."sourcePostId", p.content
      FROM posts p JOIN import_mappings m ON m."localPostId" = p.id
     WHERE m.source = $1 AND p.content ~ $2
    UNION ALL
    SELECT 'comment' AS kind, c.id, m."sourceTopicId", m."sourcePostId", c.content
      FROM comments c JOIN import_mappings m ON m."localCommentId" = c.id
     WHERE m.source = $1 AND c.content ~ $2
     ORDER BY "sourceTopicId", id
  `, IMPORT_SOURCE, BAD_URL_SQL_RE)
  return rows.map((r) => ({ ...r, kind: r.kind as 'post' | 'comment' }))
}

/**
 * 精确抓取指定楼层的 cooked。
 *
 * 只抓「确实有坏链的楼」而不是整帖:坏链在哪一楼,那一楼的 cooked 里就有对应 `<img>`
 * (raw 与 cooked 是同一楼的两种表示),所以按 post_ids 点抓即可,
 * 实测每主题最多 11 个坏楼层,远小于 batch 上限 → **每主题恰好 1 次请求**。
 *
 * [说明] 这里没有复用 import-topic.ts 的 fetchAllPosts:那个函数未导出,
 * 且它的语义是「拉全帖所有楼」,请求数会翻几倍。本脚本按文件权限边界不改 import-topic.ts。
 */
async function fetchCookedFor(
  topicId: number,
  sourcePostIds: number[],
): Promise<DiscoursePost[] | null> {
  const qs = sourcePostIds.map((id) => `post_ids[]=${id}`).join('&')
  const res = await fetchNodelocJson<DiscoursePostsResponse>(`/t/${topicId}/posts.json?${qs}`)
  return res?.post_stream?.posts ?? null
}

/**
 * 修一行正文,返回新正文与统计;没有任何一处修成功则返回 null(调用方跳过,不产生 UPDATE)。
 */
async function repairContent(
  content: string,
  maps: ReturnType<typeof buildTopicImageMaps>,
  topicId: number,
): Promise<{ next: string; fixed: number; failed: number } | null> {
  let next = content
  let fixed = 0
  let failed = 0

  // ① 裸 sha1 直链 → 经 cooked 换址后下载
  for (const url of new Set(content.match(BARE_URL_RE) ?? [])) {
    const local = await downloadUploadUrl(url, maps.srcBySha1, topicId)
    if (local) {
      next = next.split(url).join(local)
      fixed++
    } else {
      failed++
    }
  }

  // ② 404 假占位 → 按 token 查 cooked 真实地址后下载
  // 用 matchAll 而不是 match + exec:/g 正则的 exec 会带 lastIndex 状态,复用极易漏匹配
  const fakes = new Map<string, string>()
  for (const m of content.matchAll(FAKE_404_RE)) fakes.set(m[0], m[1]!)
  for (const [m, token] of fakes) {
    const remote = maps.remoteByToken.get(token)
    if (!remote) {
      failed++
      continue
    }
    const absolute = remote.startsWith('http') ? remote : NODELOC_BASE_URL + remote
    const local = await downloadUploadUrl(absolute, maps.srcBySha1, topicId)
    if (local) {
      next = next.split(m).join(local)
      fixed++
    } else {
      failed++
    }
  }

  // ③ C 类真实 cooked 图片直链 → 直接落地换址(它本身可下载,downloadUploadUrl 会先试 sha1 换址、
  // 再回退直连原链,两条路都通向同一张图,所以这里不需要 cooked 映射也能成功)
  for (const url of new Set(content.match(REAL_UPLOAD_URL_RE) ?? [])) {
    const local = await downloadUploadUrl(url, maps.srcBySha1, topicId)
    if (local) {
      next = next.split(url).join(local)
      fixed++
    } else {
      failed++
    }
  }

  return next === content ? null : { next, fixed, failed }
}

async function main() {
  const { apply, restart, limit } = parseArgs()
  const mode = apply ? 'APPLY(写库)' : 'DRY-RUN(只报不改)'
  console.log(`[repair] 模式:${mode}`)

  const candidates = await loadCandidates()
  const byTopic = new Map<number, Candidate[]>()
  for (const c of candidates) {
    const list = byTopic.get(c.sourceTopicId) ?? []
    list.push(c)
    byTopic.set(c.sourceTopicId, list)
  }

  const checkpoint = loadCheckpoint(restart)
  const done = new Set(checkpoint.doneTopicIds)
  const allTopicIds = [...byTopic.keys()].sort((a, b) => a - b)
  const todoTopicIds = allTopicIds.filter((id) => !done.has(id)).slice(0, limit)

  // 影响面与成本预估
  const badUrlCount = candidates.reduce((n, c) => n + countBadUrls(c.content), 0)
  const floors = new Set(candidates.map((c) => c.sourcePostId)).size
  // 耗时预估只能算**本轮真要处理的**主题,不能拿全库坏链数去乘：
  // 否则 `--limit 3` 也会报出全量的 8 分钟，操作者按它排工序会被误导。
  const todoBadUrlCount = todoTopicIds.reduce((n, id) => {
    for (const c of byTopic.get(id) ?? []) n += countBadUrls(c.content)
    return n
  }, 0)
  const estMs = todoTopicIds.length * JSON_INTERVAL_MS + todoBadUrlCount * ASSET_INTERVAL_MS
  console.log(
    [
      `[repair] 候选行 ${candidates.length}(posts ${candidates.filter((c) => c.kind === 'post').length} / comments ${candidates.filter((c) => c.kind === 'comment').length})`,
      `[repair] 坏链出现 ${badUrlCount} 处,涉及源楼层 ${floors} 个、源主题 ${allTopicIds.length} 个`,
      `[repair] 本轮待处理主题 ${todoTopicIds.length} 个(断点已完成 ${done.size} 个,--limit 截断 ${allTopicIds.length - done.size - todoTopicIds.length} 个)`,
      `[repair] 预计源站请求:JSON ${todoTopicIds.length} 次 + 图片 ≤${todoBadUrlCount} 次(本轮范围内)`,
      `[repair] 预计耗时:约 ${(estMs / 60000).toFixed(1)} 分钟(按串行节流 ${JSON_INTERVAL_MS}/${ASSET_INTERVAL_MS}ms 估)`,
    ].join('\n'),
  )

  if (!apply) {
    console.log('\n[repair] === DRY-RUN 明细(前 20 个主题)===')
    for (const tid of todoTopicIds.slice(0, 20)) {
      const rows = byTopic.get(tid)!
      const n = rows.reduce((a, c) => a + countBadUrls(c.content), 0)
      console.log(
        `  主题 ${tid}:${rows.length} 行待修(${rows.map((r) => `${r.kind}#${r.id}`).join(', ')}),共 ${n} 处坏链`,
      )
    }
    console.log(
      `\n[repair] DRY-RUN 结束,未写库、未下载任何图片。真正执行请加 --apply(由调度者执行)。`,
    )
    await prisma.$disconnect()
    return
  }

  const stats = checkpoint.stats
  let sinceCheckpoint = 0

  for (const tid of todoTopicIds) {
    const rows = byTopic.get(tid)!
    const postIds = [...new Set(rows.map((r) => r.sourcePostId))]
    const posts = await fetchCookedFor(tid, postIds)
    stats.topics++

    if (!posts || posts.length === 0) {
      stats.topicsMissing++
      console.warn(`[repair] 主题 ${tid} 抓不到 cooked(已删/登录可见),${rows.length} 行保持原样`)
    } else {
      const maps = buildTopicImageMaps(posts)
      for (const row of rows) {
        const result = await repairContent(row.content, maps, tid)
        if (!result) continue
        stats.imagesFixed += result.fixed
        stats.imagesFailed += result.failed
        if (row.kind === 'post') {
          await prisma.post.update({ where: { id: row.id }, data: { content: result.next } })
          stats.postsUpdated++
        } else {
          await prisma.comment.update({ where: { id: row.id }, data: { content: result.next } })
          stats.commentsUpdated++
        }
        console.log(
          `[repair] ${row.kind}#${row.id}(主题 ${tid})已修 ${result.fixed} 处,失败 ${result.failed} 处`,
        )
      }
    }

    done.add(tid)
    if (++sinceCheckpoint >= CHECKPOINT_EVERY) {
      writeFileSync(
        CHECKPOINT_FILE,
        JSON.stringify({ doneTopicIds: [...done].sort((a, b) => a - b), stats }, null, 2),
      )
      sinceCheckpoint = 0
      console.log(`[repair] 断点已存:已完成 ${done.size}/${allTopicIds.length} 个主题`)
    }
  }

  writeFileSync(
    CHECKPOINT_FILE,
    JSON.stringify({ doneTopicIds: [...done].sort((a, b) => a - b), stats }, null, 2),
  )
  console.log(`\n[repair] 完成:${JSON.stringify(stats)}`)
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('[repair] 异常终止(断点已保留,可直接重跑续传):', err)
  await prisma.$disconnect()
  process.exit(1)
})
