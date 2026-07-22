import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildMinimalHealthResponse, healthReadinessStatusCode } from "@/lib/health-readiness";
import { runtimeAuthSecretError } from "@/lib/runtime-config";
import { verifyComplianceSourceIntegrity } from "@/lib/compliance-source-integrity";
import { existsSync } from "fs";
import { join } from "path";

export const runtime = "nodejs";

export async function GET() {
  const requiredSourcePaths = [
    join(process.cwd(), "data", "pub1075", "p1075-full-text.md"),
    join(process.cwd(), "data", "nist", "sp800-53-rev5-controls.json"),
    join(process.cwd(), "data", "scsem-manifest.json"),
  ];
  let ready = requiredSourcePaths.every((sourcePath) => existsSync(sourcePath)) &&
    runtimeAuthSecretError(process.env) === null;
  try {
    verifyComplianceSourceIntegrity();
    await db.$queryRaw`SELECT 1`;
  } catch {
    ready = false;
  }

  return NextResponse.json(buildMinimalHealthResponse(ready), {
    status: healthReadinessStatusCode(ready),
  });
}
