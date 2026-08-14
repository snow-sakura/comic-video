-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptTemplate_scope_projectId_idx" ON "PromptTemplate"("scope", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_key_scope_projectId_key" ON "PromptTemplate"("key", "scope", "projectId");
