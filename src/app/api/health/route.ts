import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const health: {
    status: string;
    timestamp: string;
    database: string;
    version: string;
  } = {
    status: "ok",
    timestamp: new Date().toISOString(),
    database: "unknown",
    version: "1.0.0",
  };

  try {
    await db.$queryRaw`SELECT 1`;
    health.database = "connected";
  } catch {
    health.database = "disconnected";
    health.status = "degraded";
  }

  return NextResponse.json(health, {
    status: health.status === "ok" ? 200 : 503,
  });
}
