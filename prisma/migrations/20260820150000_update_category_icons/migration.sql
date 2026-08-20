-- 分类图标 emoji → SVG key（与前端 constants/icons.ts 的 CATEGORY_ICONS 目录对齐）。
-- 此前 emoji→key 只改了本地库（后台手工改）未落盘，导致测试服 migrate deploy 建库仍为 emoji。
-- 按 slug 定位幂等 UPDATE；仅新增迁移，不改已应用的 add_categories（防 checksum 冲突）。
UPDATE "categories" SET "icon" = 'message-circle' WHERE "slug" = 'general';
UPDATE "categories" SET "icon" = 'brain'          WHERE "slug" = 'llm';
UPDATE "categories" SET "icon" = 'bot'            WHERE "slug" = 'agent';
UPDATE "categories" SET "icon" = 'pen-tool'       WHERE "slug" = 'prompt';
UPDATE "categories" SET "icon" = 'image'          WHERE "slug" = 'art';
UPDATE "categories" SET "icon" = 'git-branch'     WHERE "slug" = 'opensource';
UPDATE "categories" SET "icon" = 'wrench'         WHERE "slug" = 'tools';
UPDATE "categories" SET "icon" = 'book-open'      WHERE "slug" = 'paper';
UPDATE "categories" SET "icon" = 'lightbulb'      WHERE "slug" = 'share';
