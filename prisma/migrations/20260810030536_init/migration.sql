-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'SCRIPTING', 'ASSETING', 'STORYBOARDING', 'RENDERING', 'DONE');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('CHARACTER', 'SCENE', 'PROP', 'STYLE');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('DRAFTING', 'REVIEWING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('LLM', 'IMAGE', 'VIDEO', 'TTS', 'MUSIC', 'SFX', 'COMPOSE');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'PROCESSING', 'DONE', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ShotStatus" AS ENUM ('PENDING', 'PROMPT_READY', 'IMAGE_GENERATING', 'IMAGE_DONE', 'IMAGE_FAILED', 'VIDEO_GENERATING', 'VIDEO_DONE', 'VIDEO_FAILED', 'VOICE_GENERATING', 'VOICE_DONE', 'COMPOSED', 'REJECTED');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "style" JSONB,
    "novelPath" TEXT,
    "novelText" TEXT,
    "novelMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Script" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "logline" TEXT,
    "content" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "appearance" JSONB NOT NULL,
    "personality" JSONB NOT NULL,
    "costume" JSONB,
    "refImageIds" TEXT[],
    "voiceId" TEXT,
    "voiceName" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'DRAFTING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scene" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mood" TEXT,
    "refImageIds" TEXT[],
    "status" "AssetStatus" NOT NULL DEFAULT 'DRAFTING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "name" TEXT NOT NULL,
    "imageIds" TEXT[],
    "meta" JSONB,
    "status" "AssetStatus" NOT NULL DEFAULT 'DRAFTING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT,
    "hookEnd" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "finalPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shot" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "sceneName" TEXT,
    "sceneId" TEXT,
    "camera" JSONB NOT NULL,
    "action" TEXT,
    "dialog" TEXT,
    "dialogChar" TEXT,
    "dialogEmotion" TEXT,
    "duration" DOUBLE PRECISION NOT NULL,
    "prompt7" JSONB,
    "finalPrompt" TEXT,
    "imagePath" TEXT,
    "videoPath" TEXT,
    "voicePath" TEXT,
    "subtitlePath" TEXT,
    "status" "ShotStatus" NOT NULL DEFAULT 'PENDING',
    "retries" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenTask" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "type" "TaskType" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "providerTaskId" TEXT,
    "input" JSONB,
    "cost" DOUBLE PRECISION,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE INDEX "Script_projectId_idx" ON "Script"("projectId");

-- CreateIndex
CREATE INDEX "Character_projectId_idx" ON "Character"("projectId");

-- CreateIndex
CREATE INDEX "Scene_projectId_idx" ON "Scene"("projectId");

-- CreateIndex
CREATE INDEX "Asset_projectId_type_idx" ON "Asset"("projectId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_projectId_number_key" ON "Episode"("projectId", "number");

-- CreateIndex
CREATE INDEX "Shot_episodeId_sequence_idx" ON "Shot"("episodeId", "sequence");

-- CreateIndex
CREATE INDEX "GenTask_status_idx" ON "GenTask"("status");

-- CreateIndex
CREATE INDEX "GenTask_projectId_idx" ON "GenTask"("projectId");

-- AddForeignKey
ALTER TABLE "Script" ADD CONSTRAINT "Script_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shot" ADD CONSTRAINT "Shot_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenTask" ADD CONSTRAINT "GenTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
