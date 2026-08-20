import { z } from 'zod'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { UserLevel } from '../../constants/business.js'

/**
 * 游戏化配置服务（签到奖励 / 等级体系）。
 *
 * 配置来源：admin 后端直写共享 Redis（key: config:checkin / config:levels，见 constants/redis-keys.ts）。
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

/** 默认等级：鸡爪≥0 / 鸡腿≥100 / 鸡肉≥500（按 minTotal 降序，与配置存储同序） */
export const DEFAULT_LEVELS: LevelConfig[] = [
  { key: UserLevel.MEAT, name: '鸡肉', minTotal: 500 },
  { key: UserLevel.LEG, name: '鸡腿', minTotal: 100 },
  { key: UserLevel.CLAW, name: '鸡爪', minTotal: 0 },
]

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
 * 等级列表 schema：非空、key 唯一、恰好一个 minTotal=0 的起始等级、按 minTotal 严格降序。
 * 任一不满足即整体兜底，避免 admin 配出「无基础等级」或「门槛乱序」导致等级判定错乱。
 */
const levelsSchema = z
  .array(levelConfigSchema)
  .min(1, '等级列表不能为空')
  .superRefine((levels, ctx) => {
    const keys = levels.map((l) => l.key)
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '等级 key 必须唯一' })
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
