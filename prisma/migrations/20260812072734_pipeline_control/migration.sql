-- CreateTable
CREATE TABLE "PipelineControl" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "paused" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineControl_pkey" PRIMARY KEY ("id")
);
