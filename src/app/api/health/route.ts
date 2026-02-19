import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const health: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    env: {
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_URL: process.env.DATABASE_URL ? `${process.env.DATABASE_URL.substring(0, 20)}...` : "NOT SET",
      AUTH_SECRET: process.env.AUTH_SECRET ? "SET" : "NOT SET",
      AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST || "NOT SET",
      NEXTAUTH_URL: process.env.NEXTAUTH_URL || "NOT SET",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
        ? `${process.env.ANTHROPIC_API_KEY.substring(0, 15)}...`
        : "NOT SET",
    },
    database: "unknown",
    userCount: 0,
  };

  try {
    await db.$queryRaw`SELECT 1`;
    health.database = "connected";
    try {
      const count = await db.user.count();
      health.userCount = count;
    } catch (e) {
      health.userCount = `error: ${e}`;
    }
  } catch (e) {
    health.database = `disconnected: ${e}`;
    health.status = "degraded";
  }

  return NextResponse.json(health, { status: 200 });
}
