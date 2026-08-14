-- CreateIndex
CREATE INDEX "Project_updatedAt_idx" ON "Project"("updatedAt");

-- CreateIndex
CREATE INDEX "GenTask_projectId_status_idx" ON "GenTask"("projectId", "status");
