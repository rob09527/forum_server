-- 顶层评论删除时级联删除其楼中楼回复（replies 的 parentId 从 SET NULL 改为 CASCADE）
ALTER TABLE "comments" DROP CONSTRAINT "comments_parentId_fkey";

ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "comments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
