#!/usr/bin/env bash
# ============================================================
# 检查 Prisma 迁移历史 与 schema.prisma 是否一致。
# 防「持续开发中改了 schema 却忘了生成迁移」→ 部署后线上缺表/缺列。
#
# 需要 SHADOW_DATABASE_URL（server/.env 里配置，指向任意本地 PG，
# Prisma 会用它建临时 shadow 库回放迁移历史，只读不动共享库）。
# 未配置则跳过（不会误报）。
#
# 退出码：0 = 一致 / 1 = 有漂移或执行失败
# ============================================================
set -u
cd "$(dirname "$0")/.."

# 让 prisma.config.ts 能读到 .env 里的 SHADOW_DATABASE_URL / DATABASE_URL
if [[ -f .env ]]; then
  set -a; source ./.env; set +a
fi

if [[ -z "${SHADOW_DATABASE_URL:-}" ]]; then
  echo "[db:check] 未设置 SHADOW_DATABASE_URL，跳过（在 server/.env 配置后可用，见 .env.example）"
  exit 0
fi

npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema prisma/schema.prisma \
  --script --exit-code >/dev/null 2>/tmp/db-check-err.log
code=$?

if [ "$code" -eq 0 ]; then
  echo "[db:check] ✓ 迁移历史与 schema 一致"
  exit 0
fi
if [ "$code" -eq 2 ]; then
  echo "[db:check] ✗ 检测到未落迁移的 schema 变更（改了 schema 忘了生成迁移？）" >&2
  echo "    生成迁移流程见 docs/部署配置清单.md 六.1（migrate diff --script → 建迁移目录 → db:deploy）" >&2
  exit 1
fi
echo "[db:check] 执行出错（exit ${code}），检查 SHADOW_DATABASE_URL 与迁移目录" >&2
cat /tmp/db-check-err.log >&2
exit "$code"
