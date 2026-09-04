#!/usr/bin/env bash
# ============================================================
# 导出 forum 业务数据快照(只读操作,不写库)。
#
# 用途:NodeLoc 数据导入前后各打一次快照,导入出问题可用
#       restore-snapshot.sh 回滚,不必重跑通宵回填。
#
# 产物(输出目录 server/.snapshots/,已加入 .gitignore):
#   .snapshots/forum-<YYYYMMDD-HHMMSS>/
#     ├── db.dump          pg_dump 自定义格式(-Fc),只含下方 FORUM_TABLES 列出的业务表
#     ├── uploads.tar.gz   server/public/uploads 整目录(帖内图片/头像,DB 只存相对路径)
#     └── manifest.txt     快照元信息(时间/库/表数/行数/uploads 体积),排障用
#
# ⚠️ 严禁把 base_sys_*(Cool Admin 的 TypeORM 表)和 _prisma_migrations 放进快照:
#    共享库由两套 ORM 共管,快照混入这两类表会在恢复时把后台账号/迁移历史一起回退。
#    因此这里用**显式 -t 白名单**(见 FORUM_TABLES),不用 --exclude-table 反选
#    ——反选一旦对方新建表就会被静默带上。
#    白名单来源:server/prisma/schema.prisma 里所有 model 的 @@map 值。
#    脚本启动时会自动比对 schema.prisma,发现新增/改名的表直接报错,防清单腐化。
#
# 连接参数(全部可用环境变量覆盖,不写死):
#   DATABASE_URL  优先,直接作为连接串传给 pg_dump(server/.env 里已有)
#   否则用 PGHOST / PGPORT / PGUSER / PGDATABASE,默认 127.0.0.1 / 5432 / rob / forum
#
# 用法:
#   bash scripts/import-nodeloc/export-snapshot.sh            # 打快照
#   bash scripts/import-nodeloc/export-snapshot.sh --dry-run  # 只做前置检查,不落盘
#
# 退出码:0 = 成功 / 1 = 前置检查或导出失败
# ============================================================
set -euo pipefail

# ---------- 路径:脚本位于 server/scripts/import-nodeloc/,上溯三级到 server/ ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$SERVER_DIR"

SNAPSHOT_ROOT="${SNAPSHOT_ROOT:-${SERVER_DIR}/.snapshots}"
UPLOADS_DIR="${SERVER_DIR}/public/uploads"
SCHEMA_FILE="${SERVER_DIR}/prisma/schema.prisma"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ $# -gt 0 ]]; then
  echo "[export] ✗ 未知参数:$1(只支持 --dry-run)" >&2
  exit 1
fi

# ---------- forum 业务表白名单(= schema.prisma 各 model 的 @@map,按字母序) ----------
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

# ---------- 1. 前置检查:工具 ----------
for tool in pg_dump psql tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[export] ✗ 找不到 ${tool} 命令。macOS 可用 brew install postgresql@18 安装 pg 客户端" >&2
    exit 1
  fi
done

# ---------- 2. 组装连接参数 ----------
# 复用 server/.env 里的 DATABASE_URL(与 db-check.sh 同做法)
if [[ -z "${DATABASE_URL:-}" && -f "${SERVER_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${SERVER_DIR}/.env"
  set +a
fi

PG_CONN=()
if [[ -n "${DATABASE_URL:-}" ]]; then
  PG_CONN=(-d "$DATABASE_URL")
  # 从 URI 末段解析库名,仅用于日志/manifest 展示(去掉 ?query 参数)
  DB_LABEL="$(printf '%s' "$DATABASE_URL" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')"
else
  export PGHOST="${PGHOST:-127.0.0.1}"
  export PGPORT="${PGPORT:-5432}"
  export PGUSER="${PGUSER:-rob}"
  export PGDATABASE="${PGDATABASE:-forum}"
  PG_CONN=()
  DB_LABEL="${PGDATABASE}@${PGHOST}:${PGPORT}"
fi

# ---------- 3. 前置检查:能连上库 ----------
if ! psql "${PG_CONN[@]}" -tAc 'select 1' >/dev/null 2>&1; then
  echo "[export] ✗ 连不上数据库(${DB_LABEL})。检查 PG 是否在跑,或 DATABASE_URL / PGHOST 等变量" >&2
  exit 1
fi

# ---------- 4. 前置检查:白名单与 schema.prisma 是否仍一致 ----------
if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "[export] ✗ 找不到 ${SCHEMA_FILE},无法校验表清单" >&2
  exit 1
fi
schema_tables="$(grep -oE '@@map\("[A-Za-z0-9_]+"\)' "$SCHEMA_FILE" | sed -E 's/@@map\("(.+)"\)/\1/' | sort -u)"
listed_tables="$(printf '%s\n' "${FORUM_TABLES[@]}" | sort -u)"
if [[ "$schema_tables" != "$listed_tables" ]]; then
  echo "[export] ✗ 表清单已与 schema.prisma 不一致(有 model 新增/改名/删除?)" >&2
  echo "    请同步更新本脚本与 restore-snapshot.sh 的 FORUM_TABLES。差异(< 只在 schema / > 只在脚本):" >&2
  diff <(printf '%s\n' "$schema_tables") <(printf '%s\n' "$listed_tables") >&2 || true
  exit 1
fi

# ---------- 5. 前置检查:表都真实存在(防连错库) ----------
missing=""
for t in "${FORUM_TABLES[@]}"; do
  exists="$(psql "${PG_CONN[@]}" -tAc "select to_regclass('public.\"${t}\"') is not null")"
  [[ "$exists" == "t" ]] || missing="${missing} ${t}"
done
if [[ -n "$missing" ]]; then
  echo "[export] ✗ 库 ${DB_LABEL} 里缺少这些业务表:${missing}" >&2
  echo "    可能连错库,或迁移未执行(server/ 下只能跑 pnpm db:deploy)" >&2
  exit 1
fi

echo "[export] 目标库:${DB_LABEL}"
echo "[export] 业务表:${#FORUM_TABLES[@]} 张(白名单与 schema.prisma 一致 ✓)"
echo "[export] 排除项:base_sys_*(Cool Admin)、_prisma_migrations —— 未列入白名单,不会被导出"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[export] --dry-run:前置检查全部通过,未写任何文件"
  exit 0
fi

# ---------- 6. 导出 ----------
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${SNAPSHOT_ROOT}/forum-${STAMP}"
mkdir -p "$OUT_DIR"

# -t 白名单逐表指定;-Fc 自定义格式(供 pg_restore 用);--no-owner/--no-privileges 便于跨机器恢复
DUMP_TABLE_ARGS=()
for t in "${FORUM_TABLES[@]}"; do
  DUMP_TABLE_ARGS+=(-t "public.\"${t}\"")
done

echo "[export] 正在 pg_dump → ${OUT_DIR}/db.dump"
if ! pg_dump "${PG_CONN[@]}" \
  --format=custom \
  --no-owner --no-privileges \
  "${DUMP_TABLE_ARGS[@]}" \
  --file="${OUT_DIR}/db.dump" 2>"${OUT_DIR}/pg_dump.err"; then
  echo "[export] ✗ pg_dump 失败,错误输出:" >&2
  cat "${OUT_DIR}/pg_dump.err" >&2
  exit 1
fi
rm -f "${OUT_DIR}/pg_dump.err"

# uploads:DB 只存相对路径,图片不备份则恢复后全站裂图
if [[ -d "$UPLOADS_DIR" ]]; then
  echo "[export] 正在打包 uploads → ${OUT_DIR}/uploads.tar.gz"
  # -C 到 public/ 再打 uploads/,保证解包路径是 uploads/...(恢复端不依赖绝对路径)
  tar -czf "${OUT_DIR}/uploads.tar.gz" -C "${SERVER_DIR}/public" uploads
else
  echo "[export] ! 没有 ${UPLOADS_DIR},跳过图片打包"
fi

# ---------- 7. manifest:记录行数,恢复后可对比 ----------
{
  echo "# forum 业务数据快照"
  echo "生成时间: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "来源库:   ${DB_LABEL}"
  echo "pg_dump:  $(pg_dump --version)"
  echo "表数量:   ${#FORUM_TABLES[@]}"
  echo "不含:     base_sys_*(Cool Admin / TypeORM)、_prisma_migrations"
  echo
  echo "## 各表行数"
  for t in "${FORUM_TABLES[@]}"; do
    cnt="$(psql "${PG_CONN[@]}" -tAc "select count(*) from public.\"${t}\"")"
    printf '%-26s %s\n' "$t" "$cnt"
  done
  echo
  echo "## uploads"
  if [[ -d "$UPLOADS_DIR" ]]; then
    echo "目录体积: $(du -sh "$UPLOADS_DIR" | awk '{print $1}')"
    echo "文件数:   $(find "$UPLOADS_DIR" -type f | wc -l | tr -d ' ')"
  else
    echo "(无)"
  fi
} >"${OUT_DIR}/manifest.txt"

echo "[export] ✓ 快照完成:${OUT_DIR}"
ls -lh "$OUT_DIR" | tail -n +2 | awk '{printf "    %-18s %s\n", $9, $5}'
echo "[export] 恢复命令:bash scripts/import-nodeloc/restore-snapshot.sh ${OUT_DIR}"
