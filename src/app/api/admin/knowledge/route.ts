import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { hasEmbeddingConfig } from "@/lib/knowledge/embeddings";
import {
  importKnowledgeDocument,
  loadLocalPub1075,
  loadOfficialPub1075FromIrs,
} from "@/lib/knowledge/ingest";

export const maxDuration = 300;

async function requireAdmin() {
  const session = await auth();
  const user = session?.user as
    | { id: string; role: string; organizationId: string }
    | undefined;

  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (user.role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { user };
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    return JSON.parse(value);
  }
  return undefined;
}

export async function GET(request: NextRequest) {
  const { user, error } = await requireAdmin();
  if (error) return error;

  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim();
    const sourceType = searchParams.get("sourceType")?.trim();
    const page = Number(searchParams.get("page") || "1");
    const pageSize = Math.min(Number(searchParams.get("pageSize") || "25"), 100);

    const where = {
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" as const } },
              { sourceName: { contains: q, mode: "insensitive" as const } },
              { description: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(sourceType ? { sourceType } : {}),
    };

    const [documents, total, chunkCount, embeddedRows, auditCount] =
      await Promise.all([
        db.knowledgeDocument.findMany({
          where,
          orderBy: { importedAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            importedBy: { select: { name: true, email: true } },
            _count: { select: { chunks: true } },
          },
        }),
        db.knowledgeDocument.count({ where }),
        db.knowledgeChunk.count(),
        db.$queryRaw<Array<{ count: bigint }>>(
          Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "KnowledgeChunk" WHERE "embedding" IS NOT NULL`
        ),
        db.auditLog.count({ where: { organizationId: user!.organizationId } }),
      ]);

    const embeddedChunkCount = Number(embeddedRows[0]?.count || 0);

    return NextResponse.json({
      documents,
      total,
      page,
      totalPages: Math.ceil(total / pageSize),
      stats: {
        documentCount: total,
        chunkCount,
        embeddedChunkCount,
        auditCount,
        embeddingConfigured: hasEmbeddingConfig(),
      },
    });
  } catch (err) {
    console.error("Knowledge GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch knowledge documents" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const { user, error } = await requireAdmin();
  if (error) return error;

  try {
    const body = await request.json();
    const action = body.action || "import_text";

    let syncDetails: Record<string, unknown> | undefined;
    let input;

    if (action === "sync_pub1075") {
      const officialPub1075 = await loadOfficialPub1075FromIrs();
      syncDetails = {
        pdfSizeKB: officialPub1075.pdfSizeKB,
        pageCount: officialPub1075.pageCount,
        pdfSha256: officialPub1075.pdfSha256,
        textSha256: officialPub1075.textSha256,
        downloadedAt: officialPub1075.downloadedAt,
      };
      input = {
        ...officialPub1075,
        importedById: user!.id,
      };
    } else if (action === "import_pub1075") {
      input = {
        ...loadLocalPub1075(),
        importedById: user!.id,
      };
    } else {
      input = {
        title: String(body.title || ""),
        content: String(body.content || ""),
        sourceType: String(body.sourceType || "document"),
        sourceName: body.sourceName ? String(body.sourceName) : undefined,
        version: body.version ? String(body.version) : undefined,
        description: body.description ? String(body.description) : undefined,
        metadata: parseMetadata(body.metadata),
        importedById: user!.id,
      };
    }

    const result = await importKnowledgeDocument(input);

    await logAudit({
      organizationId: user!.organizationId,
      userId: user!.id,
      action: "KNOWLEDGE_DOCUMENT_IMPORT",
      resourceType: "knowledge_document",
      resourceId: result.documentId,
      metadata: {
        title: input.title,
        sourceType: input.sourceType,
        chunkCount: result.chunkCount,
        embeddedChunkCount: result.embeddedChunkCount,
        syncDetails,
      },
      ipAddress:
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        undefined,
      userAgent: request.headers.get("user-agent") || undefined,
    });

    return NextResponse.json({ success: true, ...result, syncDetails });
  } catch (err) {
    console.error("Knowledge POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to import document" },
      { status: 500 }
    );
  }
}
