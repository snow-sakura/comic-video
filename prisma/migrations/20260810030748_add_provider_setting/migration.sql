-- CreateTable
CREATE TABLE "ProviderSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderSetting_pkey" PRIMARY KEY ("key")
);
