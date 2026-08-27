import { z } from 'zod'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { UserLevel } from '../../constants/business.js'
import { ValidationError } from '../../utils/errors.js'

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
 * 从 Redis 读 JSON 配置，解析 + 校验，任一环节失败返回 undefined（调用方兜底）。
 * Redis 异常也在此吞掉（log 警告），保证核心路径不被配置读取拖垮。
 */
async function readConfigJson(key: string): Promise<unknown | undefined> {
  try {
    const raw = await redis.get(key)
    if (!raw) return undefined
    return JSON.parse(raw)
  } catch (err) {
    console.warn(`[config] 读取 ${key} 失败，使用默认值兜底:`, (err as Error).message)
    return undefined
  }
}

/** 读取签到配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getCheckinConfig(): Promise<CheckinConfig> {
  const parsed = checkinConfigSchema.safeParse(await readConfigJson(RedisKey.configCheckin))
  if (!parsed.success) return DEFAULT_CHECKIN_CONFIG
  return parsed.data
}

/** 读取等级配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getLevels(): Promise<LevelConfig[]> {
  const parsed = levelsSchema.safeParse(await readConfigJson(RedisKey.configLevels))
  if (!parsed.success) return DEFAULT_LEVELS
  return parsed.data
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
  const parsed = shopConfigSchema.safeParse(await readConfigJson(RedisKey.configShop))
  if (!parsed.success) return DEFAULT_SHOP_CONFIG
  return parsed.data
}

/** 读取打赏配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getTipConfig(): Promise<TipConfig> {
  const parsed = tipConfigSchema.safeParse(await readConfigJson(RedisKey.configTip))
  if (!parsed.success) return DEFAULT_TIP_CONFIG
  return parsed.data
}

/** 读取悬赏配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getBountyConfig(): Promise<BountyConfig> {
  const parsed = bountyConfigSchema.safeParse(await readConfigJson(RedisKey.configBounty))
  if (!parsed.success) return DEFAULT_BOUNTY_CONFIG
  return parsed.data
}

/** 读取道具配置，Redis 缺失/非法/异常一律返回默认值 */
export async function getPropsConfig(): Promise<PropsConfig> {
  const parsed = propsConfigSchema.safeParse(await readConfigJson(RedisKey.configProps))
  if (!parsed.success) return DEFAULT_PROPS_CONFIG
  return parsed.data
}

/**
 * ── 配置写入口（服务端单一 owner，admin 改走 HTTP 转发）──
 * 配置契约（Redis key 名 + zod schema + 默认值）只此一份，杜绝 admin 手抄漂移。
 * admin 后端不再直连 Redis，统一经 /api/admin/config 读写。
 */

/** 配置组标识 */
export type ConfigGroup = 'checkin' | 'levels' | 'shop' | 'tip' | 'bounty' | 'props'

/** 组 → { Redis key, 校验 schema, 读取函数 }，set/get/reset 统一分发 */
const CONFIG_GROUPS = {
  checkin: { key: RedisKey.configCheckin, schema: checkinConfigSchema, get: getCheckinConfig },
  levels: { key: RedisKey.configLevels, schema: levelsSchema, get: getLevels },
  shop: { key: RedisKey.configShop, schema: shopConfigSchema, get: getShopConfig },
  tip: { key: RedisKey.configTip, schema: tipConfigSchema, get: getTipConfig },
  bounty: { key: RedisKey.configBounty, schema: bountyConfigSchema, get: getBountyConfig },
  props: { key: RedisKey.configProps, schema: propsConfigSchema, get: getPropsConfig },
} as const satisfies Record<ConfigGroup, { key: string; schema: z.ZodTypeAny; get: () => Promise<unknown> }>

/** 6 组配置的已解析生效值 + 等级预置池（zod 校验 + 默认兜底后的真实值，admin 表单据此初始化） */
export async function getAllConfigs() {
  const [checkin, levels, shop, tip, bounty, props] = await Promise.all([
    getCheckinConfig(),
    getLevels(),
    getShopConfig(),
    getTipConfig(),
    getBountyConfig(),
    getPropsConfig(),
  ])
  return { checkin, levels, shop, tip, bounty, props, levelPool: LEVEL_POOL }
}

/** 写入一组配置：先 zod 校验再落 Redis，非法值直接抛 400，不写脏数据 */
export async function setConfig(group: ConfigGroup, value: unknown): Promise<void> {
  const entry = CONFIG_GROUPS[group]
  if (!entry) throw new ValidationError('不支持的配置组')
  const parsed = entry.schema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '值'} ${i.message}`).join('；')
    throw new ValidationError(`配置「${group}」校验失败：${detail}`)
  }
  await redis.set(entry.key, JSON.stringify(parsed.data))
}

/** 删除一组配置：forum 侧自动回退代码内置默认值 */
export async function resetConfig(group: ConfigGroup): Promise<void> {
  const entry = CONFIG_GROUPS[group]
  if (!entry) throw new ValidationError('不支持的配置组')
  await redis.del(entry.key)
}
