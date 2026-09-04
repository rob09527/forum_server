#!/usr/bin/env bash
# ============================================================
# 从 export-snapshot.sh 的产物恢复 forum 业务数据。
#
# ⚠️⚠️ 破坏性操作:会 DROP 并重建下方 FORUM_TABLES 列出的 21 张业务表,
#      当前库里这些表的数据**全部丢失**,替换为快照内容。执行前必须交互确认。
#
# 不碰的东西(重要):
#   - base_sys_*        Cool Admin(TypeORM)的后台账号/菜单/权限表 —— 快照里根本没有
#   - _prisma_migrations Prisma 迁移历史 —— 快照里根本没有,恢复后迁移状态不变
#   两者不在快照白名单内,pg_restore 无从触及。所以本脚本**不会**把后台账号回退。
#
# 恢复方式:pg_restore --clean --if-exists --single-transaction
#   - --clean:先 DROP 快照里的表/约束再重建(pg_dump 已按依赖逆序排好 DROP,不用手动排 FK)
#   - --single-transaction:全程一个事务,任何一步失败整体回滚,不会留下半个库
#
# 连接参数(可用环境变量覆盖,不写死):
#   DATABASE_URL 优先;否则 PGHOST / PGPORT / PGUSER / PGDATABASE,
#   默认 127.0.0.1 / 5432 / rob / forum
#
# 用法:
#   bash scripts/import-nodeloc/restore-snapshot.sh .snapshots/forum-20260903-120000
#   bash scripts/import-nodeloc/restore-snapshot.sh <快照目录> --db-only     # 只恢复库,不动图片
#   bash scripts/import-nodeloc/restore-snapshot.sh <快照目录> --uploads-only # 只恢复图片,不动库
#
# 退出码:0 = 成功 / 1 = 前置检查失败、用户取消 或 恢复失败
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$SERVER_DIR"

UPLOADS_PARENT="${SERVER_DIR}/public"
UPLOADS_DIR="${UPLOADS_PARENT}/uploads"

# ---------- forum 业务表白名单(与 export-snapshot.sh 保持一致) ----------
FORUM_TABLES=(
  adverts
  announcements
  bookmarks
  bounties
  categories
  comment_likes
  comments
  conversations
  follows
  import_mappings
  import_user_mappings
  messages
  notification_messages
  notifications
  point_logs
  post_likes
  posts
  shop_items
  tips
  user_decorations
  users
)

# ---------- 1. 参数 ----------
if [[ $# -lt 1 ]]; then
  echo "用法:bash scripts/import-nodeloc/restore-snapshot.sh <快照目录> [--db-only|--uploads-only]" >&2
  echo "可用快照:" >&2
  ls -1 "${SERVER_DIR}/.snapshots" 2>/dev/null | sed 's/^/    /' >&2 || echo "    (还没有,先跑 export-snapshot.sh)" >&2
  exit 1
fi

SNAP_DIR="$(cd "$1" 2>/dev/null && pwd || true)"
if [[ -z "$SNAP_DIR" || ! -d "$SNAP_DIR" ]]; then
  echo "[restore] ✗ 快照目录不存在:$1" >&2
  exit 1
fi
shift

DO_DB=1
DO_UPLOADS=1
case "${1:-}" in
  "") ;;
  --db-only) DO_UPLOADS=0 ;;
  --uploads-only) DO_DB=0 ;;
  *)
    echo "[restore] ✗ 未知参数:$1(只支持 --db-only / --uploads-only)" >&2
    exit 1
    ;;
esac

DUMP_FILE="${SNAP_DIR}/db.dump"
UPLOADS_TAR="${SNAP_DIR}/uploads.tar.gz"

if [[ "$DO_DB" -eq 1 && ! -f "$DUMP_FILE" ]]; then
  echo "[restore] ✗ 快照里没有 db.dump:${DUMP_FILE}" >&2
  exit 1
fi
if [[ "$DO_UPLOADS" -eq 1 && ! -f "$UPLOADS_TAR" ]]; then
  echo "[restore] ! 快照里没有 uploads.tar.gz,将跳过图片恢复"
  DO_UPLOADS=0
fi

# ---------- 2. 前置检查:工具 ----------
for tool in pg_restore psql tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[restore] ✗ 找不到 ${tool} 命令。macOS 可用 brew install postgresql@18 安装 pg 客户端" >&2
    exit 1
  fi
done

# ---------- 3. 连接参数 ----------
if [[ -z "${DATABASE_URL:-}" && -f "${SERVER_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${SERVER_DIR}/.env"
  set +a
fi

PG_CONN=()
if [[ -n "${DATABASE_URL:-}" ]]; then
  PG_CONN=(-d "$DATABASE_URL")
  DB_LABEL="$(printf '%s' "$DATABASE_URL" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')"
else
  export PGHOST="${PGHOST:-127.0.0.1}"
  export PGPORT="${PGPORT:-5432}"
  export PGUSER="${PGUSER:-rob}"
  export PGDATABASE="${PGDATABASE:-forum}"
  DB_LABEL="${PGDATABASE}@${PGHOST}:${PGPORT}"
fi

if [[ "$DO_DB" -eq 1 ]] && ! psql "${PG_CONN[@]}" -tAc 'select 1' >/dev/null 2>&1; then
  echo "[restore] ✗ 连不上数据库(${DB_LABEL})。检查 PG 是否在跑,或 DATABASE_URL / PGHOST 等变量" >&2
  exit 1
fi

# ---------- 4. 校验快照内容:只能含业务表,含 base_sys_* / _prisma_migrations 直接拒绝 ----------
if [[ "$DO_DB" -eq 1 ]]; then
  if ! dump_toc="$(pg_restore --list "$DUMP_FILE" 2>/dev/null)"; then
    echo "[restore] ✗ ${DUMP_FILE} 不是合法的 pg_dump 自定义格式文件(损坏?)" >&2
    exit 1
  fi
  if printf '%s\n' "$dump_toc" | grep -qE 'base_sys_|_prisma_migrations'; then
    echo "[restore] ✗ 快照里混入了 base_sys_* 或 _prisma_migrations,拒绝恢复!" >&2
    echo "    恢复它会把 Cool Admin 后台账号/菜单或 Prisma 迁移历史一起回退,风险极高。" >&2
    echo "    请用 export-snapshot.sh 重新打一份只含业务表的快照。" >&2
    exit 1
  fi
  # 列出快照里的表,让人在确认前看清范围
  snap_tables="$(printf '%s\n' "$dump_toc" | grep -oE 'TABLE DATA public [A-Za-z0-9_]+' | awk '{print $NF}' | sort -u)"
fi

# ---------- 5. 交互确认 ----------
echo
echo "=============== 即将恢复(破坏性操作)==============="
echo "  快照目录 : ${SNAP_DIR}"
[[ -f "${SNAP_DIR}/manifest.txt" ]] && echo "  快照时间 : $(grep -E '^生成时间' "${SNAP_DIR}/manifest.txt" | cut -d: -f2- | sed 's/^ *//')"
echo "  目标库   : ${DB_LABEL}"
if [[ "$DO_DB" -eq 1 ]]; then
  echo "  恢复库   : 是 —— 下列表会被 DROP 后重建,现有数据全部丢失:"
  printf '%s\n' "$snap_tables" | tr '\n' ' ' | fold -s -w 72 | sed 's/^/               /'
  echo
else
  echo "  恢复库   : 否(--uploads-only)"
fi
if [[ "$DO_UPLOADS" -eq 1 ]]; then
  echo "  恢复图片 : 是 —— 现有 public/uploads 会先改名备份为 uploads.bak-<时间戳>"
else
  echo "  恢复图片 : 否"
fi
echo "  不会触及 : base_sys_*(后台账号/菜单)、_prisma_migrations(迁移历史)"
echo "===================================================="
echo
if [[ ! -t 0 ]]; then
  echo "[restore] ✗ 当前不是交互终端,拒绝在无人确认的情况下恢复。请在终端里直接运行本脚本。" >&2
  exit 1
fi
printf '确认恢复?请完整输入目标库名「%s」以继续(其它任何输入取消):' "$DB_LABEL"
read -r answer
if [[ "$answer" != "$DB_LABEL" ]]; then
  echo "[restore] 已取消,未做任何改动。"
  exit 1
fi

# ---------- 6. 恢复数据库 ----------
if [[ "$DO_DB" -eq 1 ]]; then
  echo "[restore] 正在 pg_restore(单事务,失败自动整体回滚)…"
  err_log="$(mktemp -t forum-restore)"
  if ! pg_restore "${PG_CONN[@]}" \
    --clean --if-exists \
    --no-owner --no-privileges \
    --single-transaction \
    "$DUMP_FILE" 2>"$err_log"; then
    echo "[restore] ✗ pg_restore 失败,库已回滚到恢复前状态。错误输出:" >&2
    cat "$err_log" >&2
    rm -f "$err_log"
    exit 1
  fi
  rm -f "$err_log"
  echo "[restore] ✓ 数据库恢复完成。各表行数:"
  for t in "${FORUM_TABLES[@]}"; do
    cnt="$(psql "${PG_CONN[@]}" -tAc "select count(*) from public.\"${t}\"" 2>/dev/null || echo '?')"
    printf '    %-26s %s\n' "$t" "$cnt"
  done
  echo "[restore] 可与快照 manifest.txt 的行数对比:${SNAP_DIR}/manifest.txt"
fi

# ---------- 7. 恢复 uploads ----------
if [[ "$DO_UPLOADS" -eq 1 ]]; then
  mkdir -p "$UPLOADS_PARENT"
  if [[ -d "$UPLOADS_DIR" ]]; then
    backup="${UPLOADS_DIR}.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$UPLOADS_DIR" "$backup"
    echo "[restore] 原图片目录已备份为:${backup}(确认无误后自行删除)"
  fi
  echo "[restore] 正在解包 uploads…"
  tar -xzf "$UPLOADS_TAR" -C "$UPLOADS_PARENT"
  echo "[restore] ✓ 图片恢复完成:${UPLOADS_DIR}($(find "$UPLOADS_DIR" -type f | wc -l | tr -d ' ') 个文件)"
fi

echo
echo "[restore] ✓ 全部完成。后续建议:"
echo "    1) cd ${SERVER_DIR} && pnpm search:reindex   # Meilisearch 索引与库已错位,需重建"
echo "    2) pnpm points:audit                          # 校验积分账本三条不变量"
echo "    3) pnpm tsx src/scripts/import-nodeloc/verify.ts  # 导入一致性自检"
echo "    注意:恢复覆盖了业务表,Redis 里的缓存/计数器(如 point_daily:*、checkin:*)未回滚,"
echo "         如需一致请按前缀点名清理 —— 严禁 FLUSHDB(与 Cool Admin 共享 Redis)。"
