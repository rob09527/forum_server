import { prisma } from '../lib/prisma.js'
import { PointType } from '../constants/business.js'

/**
 * 积分账本对账脚本（docs/积分消费体系.md 审计 B2 / [R42]）。
 * 运行：pnpm tsx src/scripts/audit-points.ts
 *
 * 三条不变量（任一条不满足即报错）：
 * 1. 余额：users.points === SUM(point_logs.delta)（全类型，含 spend/credit 的负/正）
 * 2. 累计：users.totalPointsEarned === SUM(point_logs.delta where type ∈ 收入侧)（earnPoints 类型 [R44]）
 * 3. 链式：每条流水 balanceAfter === 上一条流水余额 + delta（首条从 0 起）[R42]
 *
 * 只读不写，安全可随时执行。退出码：0 = 全部对平，1 = 存在差异。
 */

/** 收入侧积分类型（earnPoints 同时增累计；spend/credit 不触碰累计 [R44][R50]） */
const INCOME_TYPES = new Set<string>([
  PointType.CHECKIN,
  PointType.POST,
  PointType.COMMENT,
  PointType.LIKED,
  PointType.TRANSFER,
])

const run = async () => {
  let issues = 0

  // ── 不变量 1 & 2：余额 / 累计 聚合对账 ──────────────────────────────
  const byUser = await prisma.pointLog.groupBy({
    by: ['userId'],
    _sum: { delta: true },
  })
  const balanceSum = new Map(byUser.map((r) => [r.userId, r._sum.delta ?? 0]))

  const incomeByUser = await prisma.pointLog.groupBy({
    by: ['userId'],
    where: { type: { in: [...INCOME_TYPES] } },
    _sum: { delta: true },
  })
  const earnedSum = new Map(incomeByUser.map((r) => [r.userId, r._sum.delta ?? 0]))

  const users = await prisma.user.findMany({
    select: { id: true, username: true, points: true, totalPointsEarned: true },
  })

  for (const u of users) {
    const sum = balanceSum.get(u.id) ?? 0
    if (sum !== u.points) {
      issues++
      console.error(
        `[余额不符] #${u.id} ${u.username}: users.points=${u.points} 但 SUM(delta)=${sum}（差 ${u.points - sum}）`,
      )
    }
    const earned = earnedSum.get(u.id) ?? 0
    if (earned !== u.totalPointsEarned) {
      issues++
      console.error(
        `[累计不符] #${u.id} ${u.username}: users.totalPointsEarned=${u.totalPointsEarned} 但 SUM(收入delta)=${earned}（差 ${u.totalPointsEarned - earned}）`,
      )
    }
  }

  // ── 不变量 3：链式对账（每条流水余额连续）────────────────────────────
  // 全表按 (userId, createdAt, id) 升序拉取，逐用户验证 balanceAfter 连续。
  // 大表场景下由 DB 排序流式处理即可；本脚本为运维工具，可接受全量读取。
  const logs = await prisma.pointLog.findMany({
    orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { userId: true, type: true, delta: true, balanceAfter: true, id: true },
  })

  const chainIssues: string[] = []
  for (let i = 0, expected = 0, lastUserId = -1; i < logs.length; i++) {
    const l = logs[i]
    if (l.userId !== lastUserId) {
      lastUserId = l.userId
      expected = 0 // 新用户从 0 起
    }
    const prev = expected // 上一条余额（首条为 0）
    if (l.balanceAfter !== prev + l.delta) {
      chainIssues.push(
        `#${l.userId} 流水#${l.id}(${l.type}, delta=${l.delta}): balanceAfter=${l.balanceAfter}，应为 ${prev + l.delta}`,
      )
      if (chainIssues.length >= 20) break // 只报前 20 条，避免刷屏
    }
    expected = l.balanceAfter
  }
  if (chainIssues.length > 0) {
    issues++
    console.error(`[链式不符] 共 ${chainIssues.length} 处流水余额断裂（仅显示前 ${chainIssues.length} 条）：`)
    for (const line of chainIssues) console.error(`  ${line}`)
  }

  // ── 汇总 ────────────────────────────────────────────────────────────
  if (issues === 0) {
    console.log(`[audit] 全部对平：${users.length} 位用户，${logs.length} 条流水，三条不变量均满足 ✓`)
    process.exit(0)
  }
  console.error(`[audit] 发现 ${issues} 处差异，请人工核查（勿直接改库，先找根因）`)
  process.exit(1)
}

run().catch((err) => {
  console.error('[audit] 执行失败:', err)
  process.exit(1)
})
