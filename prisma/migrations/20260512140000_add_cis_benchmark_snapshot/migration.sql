ALTER TABLE "CISBenchmarkVersion" ADD COLUMN "workbenchId" INTEGER;
ALTER TABLE "CISBenchmarkVersion" ADD COLUMN "benchmarkTitle" TEXT;
ALTER TABLE "CISBenchmarkVersion" ADD COLUMN "benchmarkFileName" TEXT;
ALTER TABLE "CISBenchmarkVersion" ADD COLUMN "benchmarkFilePath" TEXT;
ALTER TABLE "CISBenchmarkVersion" ADD COLUMN "benchmarkSha256" TEXT;
ALTER TABLE "CISBenchmarkVersion" ADD COLUMN "downloadedAt" TIMESTAMP(3);
ALTER TABLE "CISBenchmarkVersion" ADD COLUMN "sourceUrl" TEXT;
ALTER TABLE "CISBenchmarkVersion" ADD COLUMN "metadata" JSONB;
