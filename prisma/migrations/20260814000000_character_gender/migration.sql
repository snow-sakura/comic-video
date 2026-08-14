-- AlterEnum: 记录开发期已加入 TaskStatus 的 PAUSED 枚举值（补齐迁移历史）
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'PAUSED';

-- AlterTable: Character 增加性别字段（male | female | unknown，由提炼阶段推断）
ALTER TABLE "Character" ADD COLUMN "gender" TEXT;
