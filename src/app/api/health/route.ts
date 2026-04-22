import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { existsSync, statSync } from "fs";
import { join } from "path";

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
    pub1075: "unknown",
    knowledge: "unknown",
  };

  try {
    const pub1075Path = join(process.cwd(), "data", "pub1075", "p1075-full-text.md");
    if (existsSync(pub1075Path)) {
      health.pub1075 = `loaded: ${statSync(pub1075Path).size} bytes`;
    } else {
      health.pub1075 = "missing";
      health.status = "degraded";
    }
  } catch (e) {
    health.pub1075 = `error: ${e}`;
    health.status = "degraded";
  }

  try {
    await db.$queryRaw`SELECT 1`;
    health.database = "connected";
    try {
      const [userCount, documentCount, chunkCount, embeddedRows, vectorRows] =
        await Promise.all([
          db.user.count(),
          db.knowledgeDocument.count(),
          db.knowledgeChunk.count(),
          db.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*)::bigint AS count FROM "KnowledgeChunk" WHERE "embedding" IS NOT NULL
          `,
          db.$queryRaw<Array<{ installed: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_extension WHERE extname = 'vector'
            ) AS installed
          `,
        ]);

      health.userCount = userCount;
      health.knowledge = {
        documents: documentCount,
        chunks: chunkCount,
        embeddedChunks: Number(embeddedRows[0]?.count || 0),
        pgvector: Boolean(vectorRows[0]?.installed),
        embeddingConfigured: Boolean(process.env.OPENAI_API_KEY),
      };
    } catch (e) {
      health.userCount = `error: ${e}`;
      health.knowledge = `error: ${e}`;
    }
  } catch (e) {
    health.database = `disconnected: ${e}`;
    health.status = "degraded";
  }

  return NextResponse.json(health, { status: 200 });
}
