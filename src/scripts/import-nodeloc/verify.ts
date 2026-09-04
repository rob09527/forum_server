/**
 * NodeLoc 导入 + 造数的一致性自检(阶段 4)。
 *
 * 运行:pnpm tsx src/scripts/import-nodeloc/verify.ts
 * 只读不写,退出码 0 = 全部通过、1 = 存在问题。积分账本本身的三条不变量由
 * pnpm points:audit 负责,本脚本查的是**它查不到的那些**:冗余列、拓扑、映射完整性。
 *
 * 检查项(每项独立,一项失败不影响其余继续跑,便于一次看全问题):
 *  1. Post.commentCount = 该帖顶层评论数(楼中楼不计,与 comment.service 口径一致)
 *  2. Post.heatScore = like×300 + comment×200 + view + Σ打赏(heatBase + min(金额, heatCap))
 *  3. Comment.parentId 无悬空引用;楼中楼的父评论必须属于同一帖
 *  4. Comment.floor:顶层评论有楼层且同帖不重复,楼中楼 floor 为空
 *  5. Post/Comment 的 tipCount/tipAmount = tips 表实际聚合
 *  6. User.followerCount/followingCount = follows 表实际行数
 *  7. User.postCount/commentCount = 实际内容数(评论口径同第 1 项:仅顶层)
 *  8. 每条 UserDecoration 都有一笔对应的 shop 消费流水(金额一致)
 *  9. 佩戴槽(decor*Value)必须有一条未过期的 UserDecoration 支撑
 * 10. 占位账号「已注销用户」余额与累计必须为 0,且无关注/打赏/装饰
 * 11. import_mappings 无悬空引用:localPostId/localCommentId 指向的行必须存在、不可同时指向两者
 * 12. 正文不含未清洗残留:upload:// 伪协议、localhost 绝对地址
 * 13. 孤立映射(两侧皆空):worker 未启用时应为 0;已启用时是删除同步的正常痕迹,只提示
 * 14. 反向孤儿:影子用户名下的 Post/Comment 必须都有对应映射行
 * 15. 影子账号身份约束:一个本地账号只能被一个 sourceUserId 映射,且必须不可登录
 * 16. Comment.floor 取值合理:floor ≥ 1 且 max(floor) ≥ 顶层评论数(删除留下的空洞不算问题)
 * 17. 正文/头像引用的本地 /uploads 图片文件必须真实存在于磁盘
 * 18. 图片链接已本地化:正文/评论不得残留指向源站 uploads 的地址(裸 sha1 形态是确定死链)
 * 19. 导入积分流水自洽:post/comment 类型流水无重复,且 refId 指向的内容作者与流水归属一致
 * 20. 外链图已全部本地化:正文/评论里不得残留**指向源站的图片链接**(§9.3 唯一验收口径,必须为 0)
 */

import { access } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config.js'
import { PointType } from '../../constants/business.js'
import { getTipConfig } from '../../services/config/config.service.js'
import { IMPORT_SOURCE } from '../../services/import/import-config.js'

/** 图片存储根目录,与 import-images.ts / upload.service 同根(server/public/uploads) */
const UPLOAD_ROOT = path.resolve(process.cwd(), 'public')

/**
 * 第 18 项用的 PG 正则(ARE)。**必须锚定 Markdown/HTML 的链接目标位置**
 * (`](` 或 `src="` 之后),不能裸串匹配 —— 帖子正文里正常聊到某个域名/地址是合法内容,
 * 裸匹配会误报(坑 11:帖子 #47 正文提到 127.0.0.1:23333 曾被误报)。
 */
const LINK_ANCHOR = String.raw`(?:\]\(|src="|src=')`

/**
 * 指向源站 uploads 的**裸 sha1 短链**:`/uploads/default/<40 位 sha1>`,中间无
 * `optimized`/`original` 路径段。实测源站对该形态返回 404 —— 本地化失败后
 * 直连兜底保留原 URL,页面裂图且回源也拿不到,属确定死链。
 * (`optimized`/`original` 不是 hex,所以 `default/[0-9a-f]{40}` 天然把它们排除。)
 */
const DEAD_SHA1_LINK =
  LINK_ANCHOR + String.raw`https?://(?:www\.)?nodeloc\.com/uploads/default/[0-9a-f]{40}`

/** 指向源站 uploads 的**任何**残留:本地化成功的正文里就不该再出现源站地址 */
const SOURCE_UPLOAD_LINK = LINK_ANCHOR + String.raw`https?://(?:www\.)?nodeloc\.com/uploads/`

/** replaceImages() 的兜底占位 `nodeloc.com/404-<token>`:设计内行为,只 warn 不 fail */
const FALLBACK_404_LINK = LINK_ANCHOR + String.raw`https?://(?:www\.)?nodeloc\.com/404-`

/** 图片扩展名(与 import-images.ts 的 ALLOWED_EXTS、repair-image-urls.ts 的 C 类口径同源) */
const IMAGE_EXT = String.raw`(?:png|jpe?g|gif|webp|avif|svg)`

/**
 * 第 20 项(§9.3 的**唯一验收口径**)用的正则:**正文里残留的源站图片链接**,必须为 0。
 *
 * 锚定 `](` / `src=` 之后(理由同 LINK_ANCHOR:正文里聊到某个 URL 是合法内容),
 * 后接源站地址的三种图片形态 —— 与 repair-image-urls.ts 的 A/B/C 三类**一一对应**:
 * - C:任意路径 + 图片扩展名收尾(`original/3X/.../{sha1}.png`,真实可下载但没本地化);
 * - A:裸 sha1 `uploads/[default/]{40 hex}`(无扩展名,源站恒 404 的死图);
 * - B:`404-{token}` 兜底占位(必然裂图)。
 *
 * ⚠️ 与第 18 项的分工:18 查「`/uploads/` 下的任何源站残留」,**含 `.mp3`/`.zip` 这类附件**;
 * 本项只管**图片**。附件不在图片本地化管线范围内(inferExt 认不出、抓了也落不了盘),
 * 把它算进来这项永远归不了零 —— 所以图片与附件必须分开断言。
 */
const REMOTE_IMAGE_LINK =
  LINK_ANCHOR +
  String.raw`https?://(?:www\.)?nodeloc\.com/(?:[^\s"')]*\.` +
  IMAGE_EXT +
  String.raw`(?:[?#][^\s"')]*)?|uploads/(?:default/)?[0-9a-f]{40}|404-[A-Za-z0-9]+)`

/** 单项检查结果 */
interface CheckResult {
  /** 检查项名称(输出用) */
  name: string
  /** 问题明细,空数组 = 通过 */
  problems: string[]
  /** 本项扫过的行数,用于「查了多少」的可信度输出 */
  scanned: number
}

/** 明细最多打印多少条,避免刷屏 */
const MAX_DETAIL = 15

const results: CheckResult[] = []

/** 注册一项检查(内部抛错时记为该项失败,不中断整体) */
async function check(name: string, fn: () => Promise<Omit<CheckResult, 'name'>>): Promise<void> {
  try {
    const r = await fn()
    results.push({ name, ...r })
  } catch (err) {
    results.push({ name, problems: [`检查自身执行失败:${String(err)}`], scanned: 0 })
  }
}

/** 原始 SQL 检查的统一形态:每行给一段人类可读的问题描述 */
type RawRow = { detail: string }

/** 命中某个链接正则的正文分布:哪些行命中、总共出现多少处 */
interface LinkResidue {
  /** 人类可读的命中明细(每个内容行一条) */
  rows: string[]
  /** 出现总次数(一行正文里多张图算多次) */
  hits: number
}

/**
 * 统计 posts/comments 正文里命中给定 PG 正则的行与出现次数(只读)。
 * 用 `~` 先筛行、再对命中行 `regexp_matches(...,'g')` 计数,避免全表展开。
 */
async function scanLinkResidue(pattern: string, label: string): Promise<LinkResidue> {
  const rows: string[] = []
  let hits = 0
  const posts = await prisma.$queryRaw<{ id: number; n: bigint }[]>`
    SELECT "id", (SELECT COUNT(*) FROM regexp_matches("content", ${pattern}, 'g')) AS n
    FROM "posts" WHERE "content" ~ ${pattern}
  `
  for (const r of posts) {
    hits += Number(r.n)
    rows.push(`帖子#${r.id} ${label} ${Number(r.n)} 处`)
  }
  const comments = await prisma.$queryRaw<{ id: number; n: bigint }[]>`
    SELECT "id", (SELECT COUNT(*) FROM regexp_matches("content", ${pattern}, 'g')) AS n
    FROM "comments" WHERE "content" ~ ${pattern}
  `
  for (const r of comments) {
    hits += Number(r.n)
    rows.push(`评论#${r.id} ${label} ${Number(r.n)} 处`)
  }
  return { rows, hits }
}

async function main(): Promise<void> {
  const cfg = await getTipConfig()

  // 1. 帖子评论数(仅顶层)
  await check('Post.commentCount(仅顶层评论)', async () => {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT '帖子#' || p."id" || ' commentCount=' || p."commentCount"
             || ' 实际顶层评论=' || COALESCE(c.cnt, 0) AS detail
      FROM "posts" p
      LEFT JOIN (SELECT "postId", COUNT(*) AS cnt FROM "comments"
                 WHERE "parentId" IS NULL GROUP BY "postId") c ON c."postId" = p."id"
      WHERE p."commentCount" <> COALESCE(c.cnt, 0)
    `
    const total = await prisma.post.count()
    return { problems: rows.map((r) => r.detail), scanned: total }
  })

  // 2. 热度物化列(含打赏贡献)
  await check('Post.heatScore(含打赏贡献)', async () => {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT '帖子#' || p."id" || ' heatScore=' || p."heatScore" || ' 应为 ' || expected AS detail
      FROM (
        SELECT p.*, p."likeCount" * 300 + p."commentCount" * 200 + p."viewCount"
               + COALESCE(t.heat, 0) AS expected
        FROM "posts" p
        LEFT JOIN (
          SELECT "targetId", SUM(${cfg.heatBase}::int + LEAST("amount", ${cfg.heatCap}::int)) AS heat
          FROM "tips" WHERE "targetType" = 'post' GROUP BY "targetId"
        ) t ON t."targetId" = p."id"
      ) p
      WHERE p."heatScore" <> p.expected
    `
    const total = await prisma.post.count()
    return { problems: rows.map((r) => r.detail), scanned: total }
  })

  // 3. 楼中楼父引用
  await check('Comment.parentId 引用完整性', async () => {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT '评论#' || c."id" || ' parentId=' || c."parentId" ||
             CASE WHEN p."id" IS NULL THEN ' 父评论不存在'
                  ELSE ' 父评论属于帖子#' || p."postId" || ',自身属于帖子#' || c."postId" END AS detail
      FROM "comments" c
      LEFT JOIN "comments" p ON p."id" = c."parentId"
      WHERE c."parentId" IS NOT NULL AND (p."id" IS NULL OR p."postId" <> c."postId")
    `
    const total = await prisma.comment.count({ where: { parentId: { not: null } } })
    return { problems: rows.map((r) => r.detail), scanned: total }
  })

  // 4. 楼层号
  await check('Comment.floor(顶层有楼层、楼中楼无楼层)', async () => {
    const missing = await prisma.$queryRaw<RawRow[]>`
      SELECT '评论#' || "id" || ' 顶层评论缺 floor' AS detail
      FROM "comments" WHERE "parentId" IS NULL AND "floor" IS NULL
    `
    const extra = await prisma.$queryRaw<RawRow[]>`
      SELECT '评论#' || "id" || ' 楼中楼却有 floor=' || "floor" AS detail
      FROM "comments" WHERE "parentId" IS NOT NULL AND "floor" IS NOT NULL
    `
    const total = await prisma.comment.count()
    return { problems: [...missing, ...extra].map((r) => r.detail), scanned: total }
  })

  // 5. 打赏冗余列
  await check('打赏冗余列 tipCount/tipAmount', async () => {
    const posts = await prisma.$queryRaw<RawRow[]>`
      SELECT '帖子#' || p."id" || ' tip=' || p."tipCount" || '/' || p."tipAmount"
             || ' 实际=' || COALESCE(t.cnt, 0) || '/' || COALESCE(t.sum, 0) AS detail
      FROM "posts" p
      LEFT JOIN (SELECT "targetId", COUNT(*) AS cnt, SUM("amount") AS sum FROM "tips"
                 WHERE "targetType" = 'post' GROUP BY "targetId") t ON t."targetId" = p."id"
      WHERE p."tipCount" <> COALESCE(t.cnt, 0) OR p."tipAmount" <> COALESCE(t.sum, 0)
    `
    const comments = await prisma.$queryRaw<RawRow[]>`
      SELECT '评论#' || c."id" || ' tip=' || c."tipCount" || '/' || c."tipAmount"
             || ' 实际=' || COALESCE(t.cnt, 0) || '/' || COALESCE(t.sum, 0) AS detail
      FROM "comments" c
      LEFT JOIN (SELECT "targetId", COUNT(*) AS cnt, SUM("amount") AS sum FROM "tips"
                 WHERE "targetType" = 'comment' GROUP BY "targetId") t ON t."targetId" = c."id"
      WHERE c."tipCount" <> COALESCE(t.cnt, 0) OR c."tipAmount" <> COALESCE(t.sum, 0)
    `
    const total = await prisma.tip.count()
    return { problems: [...posts, ...comments].map((r) => r.detail), scanned: total }
  })

  // 6. 关注冗余计数
  await check('User.follower/followingCount', async () => {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT '用户#' || u."id" || ' ' || u."username" || ' 关注/粉丝='
             || u."followingCount" || '/' || u."followerCount"
             || ' 实际=' || COALESCE(a.cnt, 0) || '/' || COALESCE(b.cnt, 0) AS detail
      FROM "users" u
      LEFT JOIN (SELECT "followerId" AS uid, COUNT(*) AS cnt FROM "follows" GROUP BY 1) a ON a.uid = u."id"
      LEFT JOIN (SELECT "followeeId" AS uid, COUNT(*) AS cnt FROM "follows" GROUP BY 1) b ON b.uid = u."id"
      WHERE u."followingCount" <> COALESCE(a.cnt, 0) OR u."followerCount" <> COALESCE(b.cnt, 0)
    `
    const total = await prisma.follow.count()
    return { problems: rows.map((r) => r.detail), scanned: total }
  })

  // 7. 用户内容计数
  await check('User.postCount/commentCount', async () => {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT '用户#' || u."id" || ' ' || u."username" || ' 帖/评='
             || u."postCount" || '/' || u."commentCount"
             || ' 实际=' || COALESCE(p.cnt, 0) || '/' || COALESCE(c.cnt, 0) AS detail
      FROM "users" u
      LEFT JOIN (SELECT "authorId" AS uid, COUNT(*) AS cnt FROM "posts" GROUP BY 1) p ON p.uid = u."id"
      LEFT JOIN (SELECT "authorId" AS uid, COUNT(*) AS cnt FROM "comments"
                 WHERE "parentId" IS NULL GROUP BY 1) c ON c.uid = u."id"
      WHERE u."postCount" <> COALESCE(p.cnt, 0) OR u."commentCount" <> COALESCE(c.cnt, 0)
    `
    const total = await prisma.user.count()
    return { problems: rows.map((r) => r.detail), scanned: total }
  })

  // 8. 装饰 ↔ 消费流水
  await check('UserDecoration 有对应 shop 消费流水', async () => {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT '装饰#' || d."id" || ' 用户#' || d."userId" || ' 商品#' || d."itemId"
             || ' 价格' || d."price" || ' 找不到匹配的 shop 流水' AS detail
      FROM "user_decorations" d
      WHERE NOT EXISTS (
        SELECT 1 FROM "point_logs" l
        WHERE l."userId" = d."userId" AND l."type" = ${PointType.SHOP}
          AND l."refId" = d."itemId" AND l."delta" = -d."price"
      )
    `
    const total = await prisma.userDecoration.count()
    return { problems: rows.map((r) => r.detail), scanned: total }
  })

  // 9. 佩戴槽有据可依
  await check('佩戴槽 decor*Value 有未过期装饰支撑', async () => {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT '用户#' || u."id" || ' 佩戴 ' || kind || '=' || val || ' 但无未过期装饰' AS detail
      FROM (
        SELECT "id", 'color' AS kind, "decorColorValue" AS val, "decorColorExpireAt" AS exp,
               'username_color' AS t FROM "users" WHERE "decorColorValue" IS NOT NULL
        UNION ALL
        SELECT "id", 'title', "decorTitleValue", "decorTitleExpireAt", 'title'
               FROM "users" WHERE "decorTitleValue" IS NOT NULL
        UNION ALL
        SELECT "id", 'avatar', "decorAvatarValue", "decorAvatarExpireAt", 'avatar'
               FROM "users" WHERE "decorAvatarValue" IS NOT NULL
      ) u
      WHERE NOT EXISTS (
        SELECT 1 FROM "user_decorations" d
        WHERE d."userId" = u."id" AND d."type" = u.t AND d."renderValue" = u.val
          AND d."expireAt" > NOW()
      )
    `
    return { problems: rows.map((r) => r.detail), scanned: await prisma.userDecoration.count() }
  })

  // 10. 占位账号全额豁免
  await check('占位账号「已注销用户」零资产', async () => {
    const placeholders = await prisma.importUserMapping.findMany({
      where: { source: IMPORT_SOURCE, sourceUserId: { lt: 0 } },
      select: { localUserId: true },
    })
    const ids = placeholders.map((p) => p.localUserId)
    if (ids.length === 0) return { problems: [], scanned: 0 }

    const problems: string[] = []
    const dirty = await prisma.user.findMany({
      where: { id: { in: ids }, OR: [{ points: { not: 0 } }, { totalPointsEarned: { not: 0 } }] },
      select: { id: true, username: true, points: true, totalPointsEarned: true },
    })
    for (const u of dirty) {
      problems.push(`占位账号#${u.id} ${u.username} points=${u.points} 累计=${u.totalPointsEarned},应全为 0`)
    }
    const logs = await prisma.pointLog.count({ where: { userId: { in: ids } } })
    if (logs > 0) problems.push(`占位账号有 ${logs} 条积分流水,应为 0`)
    const tips = await prisma.tip.count({ where: { OR: [{ fromUserId: { in: ids } }, { toUserId: { in: ids } }] } })
    if (tips > 0) problems.push(`占位账号涉及 ${tips} 笔打赏,应为 0`)
    const follows = await prisma.follow.count({
      where: { OR: [{ followerId: { in: ids } }, { followeeId: { in: ids } }] },
    })
    if (follows > 0) problems.push(`占位账号涉及 ${follows} 条关注,应为 0`)
    const decors = await prisma.userDecoration.count({ where: { userId: { in: ids } } })
    if (decors > 0) problems.push(`占位账号持有 ${decors} 件装饰,应为 0`)

    return { problems, scanned: ids.length }
  })

  // 11. 映射表完整性(悬空引用 / 双指向)
  // 注意:「两侧皆空」**不在本项**——那是删除同步的正常产物,单列为第 13 项分级判断。
  await check('import_mappings 无悬空引用', async () => {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT '映射#' || m."id" || ' sourcePostId=' || m."sourcePostId" || ' ' ||
             CASE
               WHEN m."localPostId" IS NOT NULL AND m."localCommentId" IS NOT NULL THEN '同时指向帖子与评论'
               WHEN m."localPostId" IS NOT NULL THEN '帖子#' || m."localPostId" || ' 不存在'
               ELSE '评论#' || m."localCommentId" || ' 不存在'
             END AS detail
      FROM "import_mappings" m
      LEFT JOIN "posts" p ON p."id" = m."localPostId"
      LEFT JOIN "comments" c ON c."id" = m."localCommentId"
      WHERE (m."localPostId" IS NOT NULL AND m."localCommentId" IS NOT NULL)
         OR (m."localPostId" IS NOT NULL AND p."id" IS NULL)
         OR (m."localCommentId" IS NOT NULL AND c."id" IS NULL)
    `
    const total = await prisma.importMapping.count()
    return { problems: rows.map((r) => r.detail), scanned: total }
  })

  // 12. 正文清洗残留
  // 只查「图片/链接地址里的」本机地址:正文里聊到 127.0.0.1:23333 是正常内容(帖子#47 实例),
  // 裸串匹配会误报,所以用 ](scheme://host 的形态锚定 Markdown 链接目标。
  await check('正文无 upload:// / 本机绝对地址残留', async () => {
    const residue = `%upload://%`
    const localLink = `%](http%://localhost%`
    const localIpLink = `%](http%://127.0.0.1%`
    const posts = await prisma.$queryRaw<RawRow[]>`
      SELECT '帖子#' || "id" || ' 正文含未清洗残留' AS detail FROM "posts"
      WHERE "content" LIKE ${residue} OR "content" LIKE ${localLink} OR "content" LIKE ${localIpLink}
    `
    const comments = await prisma.$queryRaw<RawRow[]>`
      SELECT '评论#' || "id" || ' 正文含未清洗残留' AS detail FROM "comments"
      WHERE "content" LIKE ${residue} OR "content" LIKE ${localLink} OR "content" LIKE ${localIpLink}
    `
    const total = (await prisma.post.count()) + (await prisma.comment.count())
    return { problems: [...posts, ...comments].map((r) => r.detail), scanned: total }
  })

  // 13. 孤立映射(两侧皆空)。这是「对方删帖/删楼 → 本地移除 → 映射断开保留审计痕迹」
  // 的正常产物(见 import-sync.removeSynced),所以只在增量 worker 从未启用时才算问题。
  await check('import_mappings 孤立行(删除同步痕迹)', async () => {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT '映射#' || "id" || ' sourcePostId=' || "sourcePostId" || ' 两侧皆空' AS detail
      FROM "import_mappings"
      WHERE "localPostId" IS NULL AND "localCommentId" IS NULL
    `
    const total = await prisma.importMapping.count()
    if (rows.length > 0 && config.IMPORT_SYNC_ENABLED) {
      console.log(`  ℹ️ 孤立映射 ${rows.length} 行:worker 已启用,属删除同步痕迹,不计为问题`)
      return { problems: [], scanned: total }
    }
    return { problems: rows.map((r) => r.detail), scanned: total }
  })

  // 14. 反向孤儿:影子用户名下的内容必须都有映射行(漏建映射 → 增量同步会重复导入)
  await check('影子用户内容都有映射(反向孤儿)', async () => {
    const posts = await prisma.$queryRaw<RawRow[]>`
      SELECT '帖子#' || p."id" || ' 作者是影子用户#' || p."authorId" || ' 却无映射行' AS detail
      FROM "posts" p
      JOIN "import_user_mappings" um
        ON um."localUserId" = p."authorId" AND um."source" = ${IMPORT_SOURCE}
      WHERE NOT EXISTS (SELECT 1 FROM "import_mappings" m WHERE m."localPostId" = p."id")
    `
    const comments = await prisma.$queryRaw<RawRow[]>`
      SELECT '评论#' || c."id" || ' 作者是影子用户#' || c."authorId" || ' 却无映射行' AS detail
      FROM "comments" c
      JOIN "import_user_mappings" um
        ON um."localUserId" = c."authorId" AND um."source" = ${IMPORT_SOURCE}
      WHERE NOT EXISTS (SELECT 1 FROM "import_mappings" m WHERE m."localCommentId" = c."id")
    `
    const total = (await prisma.post.count()) + (await prisma.comment.count())
    return { problems: [...posts, ...comments].map((r) => r.detail), scanned: total }
  })

  // 15. 影子账号身份约束:一个本地账号只能对应一个 sourceUserId(去重失败会让两个人共用账号);
  // 影子/占位账号必须 passwordHash IS NULL(不可登录,决策 10/13)
  await check('影子账号唯一且不可登录', async () => {
    const dup = await prisma.$queryRaw<RawRow[]>`
      SELECT '本地账号#' || "localUserId" || ' 被 ' || COUNT(*) || ' 个 sourceUserId 映射:'
             || STRING_AGG("sourceUserId"::text, ',') AS detail
      FROM "import_user_mappings" WHERE "source" = ${IMPORT_SOURCE}
      GROUP BY "localUserId" HAVING COUNT(*) > 1
    `
    const loginable = await prisma.$queryRaw<RawRow[]>`
      SELECT '影子账号#' || u."id" || ' ' || u."username" || ' 有 passwordHash,可被登录' AS detail
      FROM "users" u
      JOIN "import_user_mappings" um
        ON um."localUserId" = u."id" AND um."source" = ${IMPORT_SOURCE}
      WHERE u."passwordHash" IS NOT NULL
    `
    const total = await prisma.importUserMapping.count()
    return { problems: [...dup, ...loginable].map((r) => r.detail), scanned: total }
  })

  // 16. 楼层号取值合理性。注意**不查空洞**:真实路径 deleteComment 与增量删除同步
  // 都不重排楼层,空洞是正常的。能断言的是 floor ≥ 1 且 max(floor) ≥ 顶层评论数
  // (max < count 只可能来自重复/错乱的楼层分配)。
  await check('Comment.floor 取值合理(≥1 且不小于楼层数)', async () => {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT '帖子#' || "postId" || ' 顶层评论 ' || cnt || ' 条,楼层区间 ' || mn || '~' || mx
             || ' 不合理' AS detail
      FROM (
        SELECT "postId", COUNT(*) AS cnt, MIN("floor") AS mn, MAX("floor") AS mx
        FROM "comments" WHERE "parentId" IS NULL AND "floor" IS NOT NULL GROUP BY "postId"
      ) t
      WHERE mn < 1 OR mx < cnt
    `
    const total = await prisma.comment.count({ where: { parentId: null } })
    return { problems: rows.map((r) => r.detail), scanned: total }
  })

  // 17. 本地图片文件实际存在。导入时图片下载失败会兜底保留远程直链,不会写 /uploads 路径;
  // 库里有 /uploads 路径但磁盘没文件 = 裂图,只能靠这项抓出来。
  await check('引用的 /uploads 图片文件存在', async () => {
    const rows = await prisma.$queryRaw<{ path: string }[]>`
      SELECT DISTINCT m[1] AS path FROM "posts",
        regexp_matches("content", '/uploads/[A-Za-z0-9_./-]+\\.(?:png|jpe?g|gif|webp|svg|avif)', 'g') AS m
      UNION
      SELECT DISTINCT m[1] AS path FROM "comments",
        regexp_matches("content", '/uploads/[A-Za-z0-9_./-]+\\.(?:png|jpe?g|gif|webp|svg|avif)', 'g') AS m
      UNION
      SELECT DISTINCT "avatar" AS path FROM "users" WHERE "avatar" LIKE '/uploads/%'
    `
    const problems: string[] = []
    for (const r of rows) {
      // 只拼相对路径,防目录穿越(理论上正则已排除 ..,双保险)
      const rel = r.path.replace(/^\/+/, '')
      if (rel.includes('..')) {
        problems.push(`图片路径含 .. 非法:${r.path}`)
        continue
      }
      try {
        await access(path.join(UPLOAD_ROOT, rel))
      } catch {
        problems.push(`引用的图片文件不存在:${r.path}`)
      }
    }
    return { problems, scanned: rows.length }
  })

  // 18. 图片本地化残留。第 12 项只查 upload:// 伪协议与本机绝对地址(坑 10/11 口径),
  // 「指向源站、且已经失效的远程图片链接」不在它的范围内 —— 实测 40% 的帖子正文里是
  // `nodeloc.com/uploads/default/<裸 sha1>` 形态,源站对它返回 404:本地化管线只认 cooked 里
  // `<img data-base62-sha1>` 的 token 映射,raw 里的裸 sha1 短链进不了映射表 → 直连下载失败 →
  // 静默保留原 URL。裂图且回源拿不到,必须由这项当哨兵(修复在 clean-markdown/import-images)。
  await check('图片链接已本地化(无源站 uploads 残留)', async () => {
    const dead = await scanLinkResidue(DEAD_SHA1_LINK, '残留源站裸 sha1 死链')
    const residue = await scanLinkResidue(SOURCE_UPLOAD_LINK, '残留源站 uploads 地址')
    // 兜底占位是设计内行为(下载失败时的显式标记),量小且可辨识,只提示不计问题
    const fallback = await scanLinkResidue(FALLBACK_404_LINK, '兜底占位')
    if (fallback.hits > 0) {
      console.log(`  ⚠️ replaceImages 兜底占位 nodeloc.com/404-* 命中 ${fallback.hits} 处(设计内行为,不计为问题)`)
    }
    console.log(`  ℹ️ 图片残留统计:裸 sha1 死链 ${dead.hits} 处 / 源站 uploads 残留合计 ${residue.hits} 处`)

    // 死链是残留的子集,两者都报但明确区分:死链=确定裂图,其余=本地化未覆盖
    const deadKeys = new Set(dead.rows.map((r) => r.split(' ')[0]))
    const others = residue.rows.filter((r) => !deadKeys.has(r.split(' ')[0]))
    const total = (await prisma.post.count()) + (await prisma.comment.count())
    return { problems: [...dead.rows, ...others], scanned: total }
  })

  // 19. 导入积分流水自洽。两条断言:
  //  a) 同一 (type, userId, refId) 只能有一条 post/comment 流水 —— 抓重复计账
  //     (增量 worker 重放与阶段 2.5 造数时序错位时最容易出这个)
  //  b) 流水的 refId 指向的内容(若仍存在)作者必须就是流水归属人 —— 抓错配
  await check('post/comment 积分流水无重复无错配', async () => {
    const dup = await prisma.$queryRaw<RawRow[]>`
      SELECT '用户#' || "userId" || ' type=' || "type" || ' refId=' || "refId"
             || ' 有 ' || COUNT(*) || ' 条重复流水' AS detail
      FROM "point_logs"
      WHERE "type" IN (${PointType.POST}, ${PointType.COMMENT}) AND "refId" IS NOT NULL
      GROUP BY "userId", "type", "refId" HAVING COUNT(*) > 1
    `
    const mismatchPost = await prisma.$queryRaw<RawRow[]>`
      SELECT '流水#' || l."id" || ' 记在用户#' || l."userId" || ' 但帖子#' || p."id"
             || ' 作者是#' || p."authorId" AS detail
      FROM "point_logs" l JOIN "posts" p ON p."id" = l."refId"
      WHERE l."type" = ${PointType.POST} AND p."authorId" <> l."userId"
    `
    const mismatchComment = await prisma.$queryRaw<RawRow[]>`
      SELECT '流水#' || l."id" || ' 记在用户#' || l."userId" || ' 但评论#' || c."id"
             || ' 作者是#' || c."authorId" AS detail
      FROM "point_logs" l JOIN "comments" c ON c."id" = l."refId"
      WHERE l."type" = ${PointType.COMMENT} AND c."authorId" <> l."userId"
    `
    const total = await prisma.pointLog.count({
      where: { type: { in: [PointType.POST, PointType.COMMENT] } },
    })
    return {
      problems: [...dup, ...mismatchPost, ...mismatchComment].map((r) => r.detail),
      scanned: total,
    }
  })

  // 20. 外链图本地化的验收哨兵(§9.3)。第 18 项是「按残留形态分级诊断」,
  // 本项是**单一布尔口径**:正文里还有没有一张图挂在源站上。必须为 0 —— 否则对方删图/防盗链
  // 就会成片裂图,而且那是别人服务器上的资源,产品上不该依赖。
  await check('外链图已全部本地化(无源站图片链接残留)', async () => {
    const residue = await scanLinkResidue(REMOTE_IMAGE_LINK, '残留源站图片链接')
    console.log(`  ℹ️ 源站图片链接残留:${residue.hits} 处,分布于 ${residue.rows.length} 行内容`)
    const total = (await prisma.post.count()) + (await prisma.comment.count())
    return { problems: residue.rows, scanned: total }
  })

  // ── 汇总 ──────────────────────────────────────────────────────────
  let failed = 0
  for (const r of results) {
    if (r.problems.length === 0) {
      console.log(`✓ ${r.name}(扫描 ${r.scanned} 行)`)
      continue
    }
    failed++
    console.error(`✗ ${r.name}:${r.problems.length} 处问题(扫描 ${r.scanned} 行)`)
    for (const p of r.problems.slice(0, MAX_DETAIL)) console.error(`    ${p}`)
    if (r.problems.length > MAX_DETAIL) {
      console.error(`    ...另有 ${r.problems.length - MAX_DETAIL} 处未显示`)
    }
  }

  if (failed === 0) {
    console.log(`\n[verify] ${results.length} 项检查全部通过。别忘了积分账本:pnpm points:audit`)
    return
  }
  console.error(`\n[verify] ${failed}/${results.length} 项检查未通过,请先定位根因再改库`)
  process.exit(1)
}

await main()
  .catch((err) => {
    console.error('[verify] 执行失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
