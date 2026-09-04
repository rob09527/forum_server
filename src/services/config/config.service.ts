import { z } from 'zod'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { UserLevel } from '../../constants/business.js'
import { ValidationError } from '../../utils/errors.js'
import { config } from '../../config.js'
import {
  getCachedConfig,
  setCachedConfig,
  invalidateCachedConfig,
  publishConfigInvalidation,
  getInFlightConfig,
  setInFlightConfig,
} from './config-cache.js'

/**
 * 游戏化配置服务（签到奖励 / 等级体系）。
 *
 * 配置来源：admin 经 HTTP 转发写入（key: config:checkin / config:levels，见 constants/redis-keys.ts；写入口见文件底部 setConfig）。
 * forum 侧只读 + 校验 + 兜底：
 * - Redis 无此 key / 值为非法 JSON / 不满足 schema → 返回下方 DEFAULT_* 默认值
 * - Redis 连接异常 → 同样兜底，绝不让配置读取拖垮签到/发帖等核心路径
 *
 * 默认值即原硬编码规则（docs/积分签到等级体系.md 是唯一规则来源），
 * 未配置时行为与改动前完全一致。
 *
 * **读取带进程内缓存**（config-cache.ts），跨实例失效走 Redis pub/sub + 软 TTL 兜底 ——
 * 为什么必须跨实例、为什么 pub/sub 还要配 TTL，见 config-cache.ts 顶部注释。
 */

/** 签到奖励配置 [R10][R11][R12] */
export interface CheckinConfig {
  /** 每日签到基础分 [R10] */
  base: number
  /** 连续签到每日加成系数 [R11]，连签第 N 天额外加 N × streakBonusPerDay */
  streakBonusPerDay: number
  /** 连续签到加成上限 [R11]，加成不超过该值 */
  streakBonusCap: number
  /** 里程碑间隔天数 [R12]，连签每满该倍数天额外奖励一次（如 7 → 第 7/14/21… 天） */
  milestoneEvery: number
  /** 里程碑奖励 [R12] */
  milestoneBonus: number
}

/** 单个等级配置 [R21]：门槛（累计鸡腿）+ 中文名 */
export interface LevelConfig {
  /** 等级标识（存 User.level），需全局唯一，如 claw / leg / meat */
  key: string
  /** 等级中文名，如 鸡爪 / 鸡腿 / 鸡肉 */
  name: string
  /** 升到该等级所需累计鸡腿（minTotal=0 为起始等级，必须恰好一个） */
  minTotal: number
}

/** 默认签到规则：5 + min(N, 5) + 每满 7 天 +30 */
export const DEFAULT_CHECKIN_CONFIG: CheckinConfig = {
  base: 5,
  streakBonusPerDay: 1,
  streakBonusCap: 5,
  milestoneEvery: 7,
  milestoneBonus: 30,
}

/**
 * 等级预置池：固定 10 档，key 预生成、不可改（存 users.level），名字/门槛为占位默认值，admin 可改。
 * 按 minTotal 降序存储（最高档在前、基础档 claw 在最后），与配置存储同序。
 * 后台只能在这 10 档内「增减激活数量」（每次 +1/−1 档、不可跳档）：激活的等级 = 本池末尾 N 项。
 * 最底 3 档沿用现有 meat/leg/claw，保证存量 users.level 数据向后兼容。
 */
export const LEVEL_POOL: LevelConfig[] = [
  { key: 'mythic', name: '神兽', minTotal: 64000 },
  { key: 'divine', name: '神鸟', minTotal: 32000 },
  { key: 'phoenix', name: '凤凰', minTotal: 16000 },
  { key: 'pheasant', name: '山鸡', minTotal: 8000 },
  { key: 'free', name: '走地鸡', minTotal: 4000 },
  { key: 'whole', name: '整鸡', minTotal: 2000 },
  { key: 'wing', name: '鸡翅', minTotal: 1000 },
  { key: UserLevel.MEAT, name: '鸡肉', minTotal: 500 },
  { key: UserLevel.LEG, name: '鸡腿', minTotal: 100 },
  { key: UserLevel.CLAW, name: '鸡爪', minTotal: 0 },
]

/** 默认激活等级：池末尾 3 档（鸡爪≥0 / 鸡腿≥100 / 鸡肉≥500），Redis 空/非法时回退 */
export const DEFAULT_LEVELS: LevelConfig[] = LEVEL_POOL.slice(-3)

/** 签到配置 schema：全部为非负整数，milestoneEvery 至少为 1 */
const checkinConfigSchema = z.object({
  base: z.number().int().min(0),
  streakBonusPerDay: z.number().int().min(0),
  streakBonusCap: z.number().int().min(0),
  milestoneEvery: z.number().int().min(1),
  milestoneBonus: z.number().int().min(0),
})

const levelConfigSchema = z.object({
  key: z.string().min(1, '等级 key 不能为空'),
  name: z.string().min(1, '等级中文名不能为空'),
  minTotal: z.number().int().min(0),
})

/**
 * 等级列表 schema：非空（1~10 档）、key 必须为预置池末尾 N 项（key 不可变/不可新增/不可跳档）、
 * 恰好一个 minTotal=0 的起始等级、按 minTotal 严格降序。
 * 任一不满足即整体兜底，避免 admin 配出「无基础等级」「门槛乱序」或「自定义 key」导致等级判定错乱。
 */
const levelsSchema = z
  .array(levelConfigSchema)
  .min(1, '等级列表不能为空')
  .max(10, '等级最多 10 档')
  .superRefine((levels, ctx) => {
    const keys = levels.map((l) => l.key)
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '等级 key 必须唯一' })
    }
    // key 必须 = 预置池末尾 N 项（N = 当前激活档数），顺序一致。
    // 一条约束同时封死「key 改名 / 重排 / 跳档 / 中途删档」：key 只能从池末尾连续取。
    const expectedKeys = LEVEL_POOL.slice(LEVEL_POOL.length - levels.length).map((l) => l.key)
    for (let i = 0; i < levels.length; i++) {
      if (levels[i].key !== expectedKeys[i]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `等级 key 必须为预置池中连续的最低 ${levels.length} 档（${expectedKeys.join(' / ')}），key 不可新增/改名/跳档`,
        })
        break
      }
    }
    if (levels.filter((l) => l.minTotal === 0).length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '必须恰好一个 minTotal=0 的起始等级' })
    }
    for (let i = 1; i < levels.length; i++) {
      if (levels[i - 1].minTotal <= levels[i].minTotal) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '等级需按 minTotal 严格降序' })
        break
      }
    }
  })

/**
 * 读一组配置：进程内缓存 → Redis → JSON 解析 → zod 校验 → 默认兜底。
 * 命中缓存时零 Redis 往返、零 zod 解析（缓存里存的就是最终生效值）。
 *
 * ⚠️ **校验失败必须打日志，不能静默兜底**。原先 6 组都是 `if (!parsed.success) return DEFAULT_*`，
 * `config:levels` 曾因此吃过亏：admin 存进一份不合 schema 的等级表，forum 侧整体回退默认值，
 * 界面上「配置明明保存成功了却不生效」，日志里一个字都没有，只能靠读代码猜。
 * 所以这里区分两种情况：
 * - Redis 里**没有这个 key**（未配置）：正常状态，静默用默认值，不刷日志；
 * - Redis 里**有值但解析/校验不过**（脏数据）：`console.error` 打出具体 issue 路径。
 *
 * Redis 异常同样吞掉（warn），保证配置读取不拖垮签到/发帖/限流等核心路径；
 * 此时也会把默认值写进缓存，避免 Redis 挂掉时每请求都去重试连接（最坏滞后 = 软 TTL）。
 *
 * @param key 配置组的 Redis key
 * @param schema 该组的 zod schema
 * @param fallback 该组的代码内置默认值
 */
async function readGroup<T>(key: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  const cached = getCachedConfig<T>(key)
  if (cached !== undefined) return cached
  const pending = getInFlightConfig<T>(key)
  if (pending) return pending

  return setInFlightConfig(key, (async () => {
    let value = fallback
    let raw: string | null
    try {
      raw = await redis.get(key)
    } catch (err) {
      // Redis 异常（基础设施故障）吞掉走默认值，不拖垮签到/发帖/限流等核心路径
      console.warn(`[config] 读取 ${key} 失败，使用默认值兜底:`, (err as Error).message)
      setCachedConfig(key, value)
      return value
    }
    if (raw) {
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        // JSON 解析失败 = 后台写进了脏数据（不是基础设施故障），必须 error 而非 warn
        console.error(`[config] ${key} 不是合法 JSON，已回退默认值（后台的修改不会生效）`)
        setCachedConfig(key, value)
        return value
      }
      const parsed = schema.safeParse(json)
      if (parsed.success) value = parsed.data
      else {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '值'} ${i.message}`).join('；')
        console.error(`[config] ${key} 内容非法，已回退默认值（后台的修改不会生效）：${detail}`)
      }
    }
    setCachedConfig(key, value)
    return value
  })())
}

/** 读取签到配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getCheckinConfig(): Promise<CheckinConfig> {
  return readGroup(RedisKey.configCheckin, checkinConfigSchema, DEFAULT_CHECKIN_CONFIG)
}

/** 读取等级配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getLevels(): Promise<LevelConfig[]> {
  return readGroup(RedisKey.configLevels, levelsSchema, DEFAULT_LEVELS)
}

/**
 * ── 消费侧配置（docs/积分消费体系.md 2.6）──
 * 与签到/等级同构：admin 直写共享 Redis、forum 只读 + zod 校验 + 默认兜底。
 * 商品价格/时效/上下架走 DB（shop_items），全局规则参数走 Redis。
 */

/** 商城配置 [2.6] */
export interface ShopConfig {
  /** 新购装饰默认时效天数（续费按各自 durationDays 叠加，此值为 UI 展示用兜底） */
  defaultDurationDays: number
  /** 到期前 N 天商城页横幅提醒 */
  remindDays: number
}

/** 打赏配置 [2.6][1.5.3] */
export interface TipConfig {
  /** 快捷金额档位（前端快捷选择按钮） */
  amounts: number[]
  /** 自定义金额下限 */
  customMin: number
  /** 自定义金额上限 */
  customMax: number
  /** 日打赏总额上限（预留，null 表示不限制） */
  dailyLimitPerUser: number | null
  /** 打赏给帖子带来的热度加成基数 [1.5.4] */
  heatBase: number
  /** 热度加成上限 [1.5.4] */
  heatCap: number
}

/** 悬赏配置 [2.6][1.6] */
export interface BountyConfig {
  /** 手续费率（结算时从赏金中扣走销毁，退款不抽水）[1.6.2] */
  feeRate: number
  /** 超时天数：托管后到期自动结算（判给最高赞 / 零回答退款）[1.6.3] */
  timeoutDays: number
  /** 悬赏金额下限 */
  amountMin: number
  /** 悬赏金额上限 */
  amountMax: number
  /** 发起门槛：累计获取积分下限（防新号刷悬赏）[1.8] */
  minTotalEarned: number
  /** 发起门槛：注册天数下限 [1.8] */
  minRegisterDays: number
  /** 单用户同时进行中的悬赏数上限 [1.8] */
  maxActivePerUser: number
}

/** 功能道具配置 [2.6][1.4] */
export interface PropsConfig {
  /** 补签价格 [R52] */
  makeupPrice: number
  /** 每月补签次数上限 [1.4.2] */
  makeupMonthlyLimit: number
  /** 改名价格 [1.4.3] */
  renamePrice: number
  /** 改名冷却天数（两次改名间隔）[1.4.3] */
  renameCooldownDays: number
  /** 单次上传扩容体积（字节）[1.4.4] */
  quotaPerPurchase: number
  /** 上传扩容价格 [1.4.4] */
  quotaPrice: number
  /** 上传扩容累计上限（字节）[1.4.4] */
  quotaTotalLimit: number
}

/** 默认商城配置 [2.6] */
export const DEFAULT_SHOP_CONFIG: ShopConfig = {
  defaultDurationDays: 30,
  remindDays: 3,
}

/** 默认打赏配置 [2.6] */
export const DEFAULT_TIP_CONFIG: TipConfig = {
  amounts: [6, 66, 188],
  customMin: 1,
  customMax: 1000,
  dailyLimitPerUser: null,
  heatBase: 500,
  heatCap: 500,
}

/** 默认悬赏配置 [2.6] */
export const DEFAULT_BOUNTY_CONFIG: BountyConfig = {
  feeRate: 0.1,
  timeoutDays: 7,
  amountMin: 50,
  amountMax: 10000,
  minTotalEarned: 0,
  minRegisterDays: 0,
  maxActivePerUser: 5,
}

/** 默认道具配置 [2.6] */
export const DEFAULT_PROPS_CONFIG: PropsConfig = {
  makeupPrice: 80,
  makeupMonthlyLimit: 3,
  renamePrice: 200,
  renameCooldownDays: 30,
  quotaPerPurchase: 10 * 1024 * 1024,
  quotaPrice: 150,
  quotaTotalLimit: 500 * 1024 * 1024,
}

const shopConfigSchema = z.object({
  defaultDurationDays: z.number().int().min(1),
  remindDays: z.number().int().min(0),
})

const tipConfigSchema = z.object({
  amounts: z.array(z.number().int().min(1)).min(1),
  customMin: z.number().int().min(1),
  customMax: z.number().int().min(1),
  dailyLimitPerUser: z.number().int().min(1).nullable(),
  heatBase: z.number().int().min(0),
  heatCap: z.number().int().min(0),
})

const bountyConfigSchema = z.object({
  feeRate: z.number().min(0).max(1),
  timeoutDays: z.number().int().min(1),
  amountMin: z.number().int().min(1),
  amountMax: z.number().int().min(1),
  minTotalEarned: z.number().int().min(0),
  minRegisterDays: z.number().int().min(0),
  maxActivePerUser: z.number().int().min(1),
})

const propsConfigSchema = z.object({
  makeupPrice: z.number().int().min(1),
  makeupMonthlyLimit: z.number().int().min(1),
  renamePrice: z.number().int().min(1),
  renameCooldownDays: z.number().int().min(1),
  quotaPerPurchase: z.number().int().min(1),
  quotaPrice: z.number().int().min(1),
  quotaTotalLimit: z.number().int().min(1),
})

/** 读取商城配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getShopConfig(): Promise<ShopConfig> {
  return readGroup(RedisKey.configShop, shopConfigSchema, DEFAULT_SHOP_CONFIG)
}

/** 读取打赏配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getTipConfig(): Promise<TipConfig> {
  return readGroup(RedisKey.configTip, tipConfigSchema, DEFAULT_TIP_CONFIG)
}

/** 读取悬赏配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getBountyConfig(): Promise<BountyConfig> {
  return readGroup(RedisKey.configBounty, bountyConfigSchema, DEFAULT_BOUNTY_CONFIG)
}

/** 读取道具配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getPropsConfig(): Promise<PropsConfig> {
  return readGroup(RedisKey.configProps, propsConfigSchema, DEFAULT_PROPS_CONFIG)
}

/**
 * ── 频率/体积限制配置（第 7 组，交接快照 §11.7）──
 * 收拢原先散落三处的限流与体积上限：
 * 1. 环境变量（`config.ts` 的 `UPLOAD_MAX_*`）→ 本组的 `upload*` 三项，**环境变量继续作为默认值**，
 *    未在后台配置时行为与改动前完全一致，也不会把运维已调过的 env 值悄悄丢掉；
 * 2. `app.ts` 硬编码（全局 600 次/分/IP、multipart fileSize）→ `apiRatePerMinute` / `uploadMaxFileSize`；
 * 3. `message.service.ts` 模块常量（私信 2000 字、30 条/分）→ `dm*` 两项。
 *
 * **积分每日上限（发帖 3 次/日、评论 10 次/日）本轮不纳入**：它已经有自己的归属
 * （`points.service.ts` 的积分规则体系），搬过来会和积分账本的记账口径纠缠，收益不抵风险。
 */

/** 频率/体积限制配置 [§11.7] */
export interface LimitsConfig {
  /** 单文件上传体积上限（字节）。默认取环境变量 `UPLOAD_MAX_FILE_SIZE`（10MB） */
  uploadMaxFileSize: number
  /** 单用户上传总配额（字节）。默认取环境变量 `UPLOAD_MAX_USER_TOTAL_SIZE`（50MB） */
  uploadMaxUserTotalSize: number
  /** 单用户上传次数上限（次/分钟）。默认取环境变量 `UPLOAD_MAX_UPLOADS_PER_MINUTE`（20） */
  uploadMaxPerMinute: number
  /** 接口请求上限（次/分钟/IP），对应限流 `api` 桶（原 `app.ts` 硬编码的 600） */
  apiRatePerMinute: number
  /** 头像图片拉取上限（次/分钟/IP），对应限流 `avatar` 桶（`/uploads/avatars/*`）。默认值推导见 DEFAULT_LIMITS_CONFIG */
  avatarFetchPerMinute: number
  /** 其余图片拉取上限（次/分钟/IP），对应限流 `image` 桶（`/uploads/*` 中的正文图/素材） */
  imageFetchPerMinute: number
  /** 单条私信正文最大字符数 */
  dmContentMaxLength: number
  /** 单用户私信发送上限（条/分钟） */
  dmMaxPerMinute: number
}

/**
 * 默认限制配置。上传三项以环境变量为默认值（见 LimitsConfig 注释），其余为原硬编码值。
 *
 * ## 头像桶 4800 次/分/IP 是怎么算出来的（不是拍的）
 * 目标是「正常操作的人永远打不到」，所以按**最坏的正常行为**算，再留倍数余量：
 * - 一个列表页最多约 50 个头像（帖子作者 + 最后回复者）→ **50 张/页**；
 * - 人手动翻页的可持续上限约 2 秒一页 → **30 页/分钟**；
 *   50 × 30 = **1500**；
 * - ×2:SSR 与客户端水合可能各请求一轮，加上快速前进/后退的重复拉取 → **3000**；
 * - ×1.6:办公室/校园/运营商 CGNAT 共用出口 IP，同一 IP 后面可能坐着若干人 → **4800**。
 *
 * 还有一条**必须**算进来的放大因子：`@fastify/static` 默认发 `Cache-Control: public, max-age=0`，
 * 浏览器每次都会带 `If-None-Match` 回来验证，而 **304 也照样计入限流计数**。
 * 也就是说「第二次访问首页」不会因为命中缓存就不占配额，余量必须按这个前提留。
 *
 * ## 图片桶 1200 次/分/IP
 * 一篇正文里图片约 20 张，连续翻帖约 15 篇/分钟 → 300；×2 余量 → 600；×1.6 共用出口 → 960，取整 **1200**。
 * 比头像桶低一个量级是刻意的：正文图才是真正可能被当图床刷的那类资源。
 *
 * ## 为什么 api 桶仍是 600
 * 保持原行为不变。把 `/uploads/*` 从这个桶里拆出去，本身就是 §8.7 第 3 项的修复
 * （头像把接口配额吃光 → 首页空列表 + 头像批量裂图），不需要再动 600 这个数。
 */
export const DEFAULT_LIMITS_CONFIG: LimitsConfig = {
  uploadMaxFileSize: config.UPLOAD_MAX_FILE_SIZE,
  uploadMaxUserTotalSize: config.UPLOAD_MAX_USER_TOTAL_SIZE,
  uploadMaxPerMinute: config.UPLOAD_MAX_UPLOADS_PER_MINUTE,
  apiRatePerMinute: 600,
  avatarFetchPerMinute: 4800,
  imageFetchPerMinute: 1200,
  dmContentMaxLength: 2000,
  dmMaxPerMinute: 30,
}

/** 1 MB 的字节数，仅用于下方上下界表达 */
const MB = 1024 * 1024

/**
 * 限制配置 schema。**每项都有上下界**：
 * 下界防「填 0 把站点锁死」（限流填 0 = 所有请求 429），
 * 上界防「填个天文数字等于没限制」，以及 `uploadMaxFileSize` 填太大直接变成内存 DoS 面。
 */
const limitsConfigSchema = z
  .object({
    uploadMaxFileSize: z.number().int().min(MB, '单文件上限不能小于 1MB').max(100 * MB, '单文件上限不能超过 100MB'),
    uploadMaxUserTotalSize: z
      .number()
      .int()
      .min(10 * MB, '用户总配额不能小于 10MB')
      .max(10 * 1024 * MB, '用户总配额不能超过 10GB'),
    uploadMaxPerMinute: z.number().int().min(1).max(600),
    apiRatePerMinute: z.number().int().min(30, '接口限流不能低于 30 次/分（会锁死正常浏览）').max(100_000),
    avatarFetchPerMinute: z.number().int().min(60, '头像限流不能低于 60 次/分（一屏就打满）').max(200_000),
    imageFetchPerMinute: z.number().int().min(30).max(100_000),
    dmContentMaxLength: z.number().int().min(1).max(20_000),
    dmMaxPerMinute: z.number().int().min(1).max(600),
  })
  .superRefine((limits, ctx) => {
    // 总配额小于单文件上限时，用户连一个满额文件都传不进去，属于配置自相矛盾
    if (limits.uploadMaxUserTotalSize < limits.uploadMaxFileSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uploadMaxUserTotalSize'],
        message: '用户总配额不能小于单文件上限',
      })
    }
    // 头像桶配额低于图片桶时，分桶就失去意义（头像才是一屏几十张的那类）
    if (limits.avatarFetchPerMinute < limits.imageFetchPerMinute) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['avatarFetchPerMinute'],
        message: '头像拉取上限不应低于普通图片上限（头像是一屏几十张的资源）',
      })
    }
  })

/** 读取限制配置，Redis 缺失/非法/异常一律返回默认值（带进程内缓存，供每请求级的限流函数调用） */
export async function getLimitsConfig(): Promise<LimitsConfig> {
  return readGroup(RedisKey.configLimits, limitsConfigSchema, DEFAULT_LIMITS_CONFIG)
}

/**
 * ── 配置写入口（服务端单一 owner，admin 改走 HTTP 转发）──
 * 配置契约（Redis key 名 + zod schema + 默认值）只此一份，杜绝 admin 手抄漂移。
 * admin 后端不再直连 Redis，统一经 /api/admin/config 读写。
 */

/** 配置组标识 */
export type ConfigGroup = 'checkin' | 'levels' | 'shop' | 'tip' | 'bounty' | 'props' | 'limits'

/** 组 → { Redis key, 校验 schema, 读取函数 }，set/get/reset 统一分发 */
const CONFIG_GROUPS = {
  checkin: { key: RedisKey.configCheckin, schema: checkinConfigSchema, get: getCheckinConfig },
  levels: { key: RedisKey.configLevels, schema: levelsSchema, get: getLevels },
  shop: { key: RedisKey.configShop, schema: shopConfigSchema, get: getShopConfig },
  tip: { key: RedisKey.configTip, schema: tipConfigSchema, get: getTipConfig },
  bounty: { key: RedisKey.configBounty, schema: bountyConfigSchema, get: getBountyConfig },
  props: { key: RedisKey.configProps, schema: propsConfigSchema, get: getPropsConfig },
  limits: { key: RedisKey.configLimits, schema: limitsConfigSchema, get: getLimitsConfig },
} as const satisfies Record<ConfigGroup, { key: string; schema: z.ZodTypeAny; get: () => Promise<unknown> }>

/**
 * 全部合法配置组名。
 * 路由层的 params 枚举必须引用这里，别再手抄一份数组
 * —— 之前 admin.routes.ts 抄了两份（PUT/DELETE 各一），新增第 7 组时两处都会漏，
 * 表现为「保存返回 400 不支持的配置组」而代码里明明注册了。
 */
export const CONFIG_GROUP_NAMES = Object.keys(CONFIG_GROUPS) as [ConfigGroup, ...ConfigGroup[]]

/** 全部配置组的已解析生效值 + 等级预置池（zod 校验 + 默认兜底后的真实值，admin 表单据此初始化） */
export async function getAllConfigs() {
  const [checkin, levels, shop, tip, bounty, props, limits] = await Promise.all([
    getCheckinConfig(),
    getLevels(),
    getShopConfig(),
    getTipConfig(),
    getBountyConfig(),
    getPropsConfig(),
    getLimitsConfig(),
  ])
  return { checkin, levels, shop, tip, bounty, props, limits, levelPool: LEVEL_POOL }
}

/**
 * 写入一组配置：先 zod 校验再落 Redis，非法值直接抛 400，不写脏数据。
 * 落库后**同步清本进程缓存 + 广播失效**：
 * 同步清是因为调用方（admin.routes.ts）紧接着就会重新读配置（如 levels 的 recomputeLevels），
 * 不能等 pub/sub 回环；广播是给其它实例用的，理由见 config-cache.ts。
 */
export async function setConfig(group: ConfigGroup, value: unknown): Promise<void> {
  const entry = CONFIG_GROUPS[group]
  if (!entry) throw new ValidationError('不支持的配置组')
  const parsed = entry.schema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '值'} ${i.message}`).join('；')
    throw new ValidationError(`配置「${group}」校验失败：${detail}`)
  }
  await redis.set(entry.key, JSON.stringify(parsed.data))
  invalidateCachedConfig(entry.key)
  await publishConfigInvalidation(entry.key)
}

/** 删除一组配置：forum 侧自动回退代码内置默认值（同样需要清缓存 + 广播，否则旧值会继续生效） */
export async function resetConfig(group: ConfigGroup): Promise<void> {
  const entry = CONFIG_GROUPS[group]
  if (!entry) throw new ValidationError('不支持的配置组')
  await redis.del(entry.key)
  invalidateCachedConfig(entry.key)
  await publishConfigInvalidation(entry.key)
}
