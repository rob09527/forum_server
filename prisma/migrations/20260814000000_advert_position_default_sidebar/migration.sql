-- AlterTable
-- 广告位下线 top（顶部横幅），默认位置改为 sidebar
ALTER TABLE "adverts" ALTER COLUMN "position" SET DEFAULT 'sidebar';
