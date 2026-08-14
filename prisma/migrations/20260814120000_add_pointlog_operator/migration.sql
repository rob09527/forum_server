-- AlterTable
-- 积分流水记录操作者：管理调整(transfer)时记录是哪个管理员操作的，用于对账审计
ALTER TABLE "point_logs" ADD COLUMN "operator" TEXT;
