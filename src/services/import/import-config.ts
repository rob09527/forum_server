/**
 * NodeLoc(Discourse)数据导入配置。
 * 调研与决策见 docs/竞品调研-NodeLoc数据同步.md、docs/交接文档-NodeLoc数据导入.md。
 * 全部导入参数集中在此,不散落各脚本(后端准则⑩:禁止硬编码)。
 */

/** 数据来源标识,写入 import_mappings.source / import_user_mappings.source */
export const IMPORT_SOURCE = 'nodeloc'

/** NodeLoc 站点根地址(匿名 JSON API) */
export const NODELOC_BASE_URL = 'https://www.nodeloc.com'

/** 请求 UA(固定,便于对方审计识别;已获站方授权) */
export const IMPORT_USER_AGENT = 'Mozilla/5.0 (compatible; ForumImportBot/1.0)'

/**
 * 全局限速:两次 JSON 接口请求最小间隔(ms)。
 * 500ms(≈2 req/s)是「安全区间」默认值:回填预计 ~20h 量级,又不触碰源站风控边界。
 * 这是唯一的风控旋钮 —— 运维若见源站返回 429 就往回调(如 800/1100)。
 */
export const REQUEST_MIN_INTERVAL_MS = 500

/** 回填窗口:仅导入最近 N 天内创建的主题(决策 7:近 12 个月) */
export const BACKFILL_WINDOW_DAYS = 365

/** 单图大小上限(字节),超过跳过并记日志(计划「一.3」) */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** 图片解码像素上限，防止高压缩比图片在 sharp 解码时耗尽内存。 */
export const MAX_IMAGE_PIXELS = 40_000_000
/** 单边像素上限，避免极端长图占用过多解码资源。 */
export const MAX_IMAGE_DIMENSION = 12_000
/** 进程内导入图片缓存的最大条目数，防止长时间回填内存无限增长。 */
export const MAX_IMAGE_CACHE_ENTRIES = 10_000
/** 同时进行的图片解码/校验任务上限。 */
export const MAX_IMAGE_PROCESSING_CONCURRENCY = 4
/** 出站 HTTP 重定向最多跟随次数，且每跳都会重新校验 NodeLoc 主机。 */
export const MAX_IMAGE_REDIRECTS = 3

/**
 * 静态资源(图片/头像)请求最小间隔(ms),与 JSON 接口分账限速。
 * 理由:/uploads 走 Cloudflare 边缘缓存,不进对方 Rails 应用层,可以比接口稍快。
 * 与 REQUEST_MIN_INTERVAL_MS 同为风控旋钮,源站 429 时往回调。
 */
export const ASSET_MIN_INTERVAL_MS = 250

/** 影子账号邮箱域(决策 13:可追踪、可审计、可下架) */
export const SHADOW_EMAIL_DOMAIN = 'import.nodeloc.local'

/**
 * 排除的 NodeLoc 分类 id(决策 4,配置可调)。命中(含子分类)的主题整帖跳过。
 * - 敏感/交易类:133 限制级(nsfw)、13 交易与交换、14 拼车、15 推广、46 虚拟币、62 梦幻西游
 * - 站务/插件类(内容强绑定对方站点,导入无意义):21 公告、12 抽奖、26 活动与互动、155 Apps(站内小游戏)
 */
export const EXCLUDED_CATEGORY_IDS = new Set([133, 13, 14, 15, 46, 62, 21, 12, 26, 155])

/**
 * NodeLoc 顶级分类 id → 我方 categories.slug 静态映射(2026-09-02 实测 site.json,12 顶级)。
 * 子分类通过 site.json 分类树向上找顶级父分类后套用;精细覆盖见 FINE_CATEGORY_MAP。
 * ⚠️ 红线:「全部」≠ general;这里 1(未分类)映射 general 是因其语义就是「综合杂项」,不是「全部」。
 */
export const TOP_CATEGORY_MAP: Record<number, string> = {
  5: 'internet', // 互联网服务
  6: 'digital', // 数码与硬件
  7: 'dev', // 科技与创作(默认编程开发,AI 类走精细覆盖)
  9: 'life', // 生活与兴趣
  1: 'general', // 未分类 → 综合讨论
  79: 'life', // 商业与金融(交易/推广子类已排除,剩优惠情报/羊毛党归生活)
  78: 'life', // 体育与健身(topic_count≈0)
  80: 'life', // 时尚与美容
  81: 'life', // 教育与职业
  82: 'life', // 自然与户外
}

/**
 * 子分类精细覆盖(优先级高于顶级映射):AI 相关内容映射到我方现有 AI 垂直分类,
 * 让导入内容与本站原生分类融合而不是全部堆进新分类。
 */
export const FINE_CATEGORY_MAP: Record<number, string> = {
  31: 'llm', // AI
  216: 'llm', // MLOps & 推理
  116: 'llm', // ai大模型信息差
  134: 'tools', // M365 Copilot
  30: 'dev', // 编程开发
  122: 'dev', // 游戏开发
  108: 'dev', // 单片机
  67: 'opensource', // 开源
  88: 'opensource', // GitHub 仓库项目分享
  111: 'apps', // 工具控
  60: 'apps', // 应用(互联网服务下)
  154: 'apps',
}

/** 顶级映射兜底 slug(映射表遗漏的新顶级分类落这里) */
export const FALLBACK_CATEGORY_SLUG = 'general'

// ──────────────────────────────────────────────────────────────────────
// 落盘子目录 —— 过渡期常量,⛔ 值现在不能改(见下)
//
// 分区规范的唯一事实来源是 `src/constants/upload-paths.ts`(`UploadPartition`),
// 规范全文见 docs/图片分区规范.md。按规范,这两个目录的**目标形态**是:
//   IMPORT_UPLOAD_SUBDIR → UploadPartition.LEGACY  ('legacy')   历史迁入正文图
//   IMPORT_AVATAR_SUBDIR → UploadPartition.AVATARS ('avatars')  影子头像与用户头像同分区(§13 决定 3)
//
// ⛔⛔ 但**现在两个值都必须保持 'nodeloc' / 'nodeloc/avatars' 不变**:
// 目录改名归**收尾流水线第 1 步,由调度者执行**(`mv` + 三条 UPDATE,见交接快照 §11.2),
// 时机是「回填结束之后、全量图片回修之前」。原因:回填进程正在跑,Node 不热更新,
// 它内存里烧着旧路径。此刻改值 → 若回填中途重启,新图落新目录、旧图留在 nodeloc/,
// 库里两种前缀混着,调度者那三条 UPDATE 就对不上了。
// 改名当天只需把下面两个字面量换成 UploadPartition.LEGACY / UploadPartition.AVATARS,
// 落盘与落库路径会一起跟着变(import-images.ts 只从这里取子目录、从 upload-paths 取根段)。
// ──────────────────────────────────────────────────────────────────────

/**
 * 导入图片落盘子目录(server/public/uploads/ 下),正文最终写相对路径 /uploads/nodeloc/...。
 * 目标形态 `UploadPartition.LEGACY`;⛔ 改名前值不可动,理由见上方整段注释。
 */
export const IMPORT_UPLOAD_SUBDIR = 'legacy'

/**
 * 影子用户头像落盘子目录。
 * 目标形态 `UploadPartition.AVATARS`(与用户自定义头像同分区、不进日期目录);
 * ⛔ 改名前值不可动,且它与 IMPORT_UPLOAD_SUBDIR 的 UPDATE **目标前缀不同**
 * (头像 → /uploads/avatars/,正文图 → /uploads/legacy/),别写成同一条 SQL。
 */
export const IMPORT_AVATAR_SUBDIR = 'avatars'

/** 增量同步:/posts.json 轮询间隔(ms),计划阶段 3 定为 2 分钟 */
export const SYNC_POLL_INTERVAL_MS = 120_000
