#!/bin/sh
# ============================================================
# forum-server 容器入口
# 启动顺序：prisma migrate deploy（幂等，只应用待执行迁移）→ 启动应用。
#
# 这是「每次重新部署自动建表/升级表」的保障：新镜像带新迁移时，
# 容器首次启动即自动补齐表结构，无需手工命令、不易遗忘。
# migrate deploy 只应用 _prisma_migrations 里未执行过的迁移文件，
# 不做 schema 漂移 diff（migrate dev 才做），因此对共享库安全：
# 不会检测/触碰 Cool Admin 的 base_sys_* 等非 Prisma 表。
# ============================================================
set -e

attempts=0
MAX_ATTEMPTS=30

echo "[entrypoint] 应用 Prisma 迁移（migrate deploy，幂等）…"
while ! npx prisma migrate deploy 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge "$MAX_ATTEMPTS" ]; then
    echo "[entrypoint] 数据库长时间不可用或迁移失败（${MAX_ATTEMPTS} 次），退出，由 restart:always 兜底重试" >&2
    exit 1
  fi
  echo "[entrypoint] 数据库未就绪，2s 后重试（${attempts}/${MAX_ATTEMPTS}）…"
  sleep 2
done

echo "[entrypoint] 迁移完成，启动 forum-server"
exec "$@"
