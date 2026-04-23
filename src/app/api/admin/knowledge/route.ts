import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { hasEmbeddingConfig } from "@/lib/knowledge/embeddings";
import {
  extractPdfTextByPage,
  importKnowledgeDocument,
  loadLocalPub1075,
  loadOfficialPub1075FromIrs,
} from "@/lib/knowledge/ingest";
import { hashText } from "@/lib/knowledge/chunking";
import {
  inferInterimGuidanceInput,
  INTERIM_GUIDANCE_SOURCE_TYPE,
} from "@/lib/knowledge/interim-guidance";

export const maxDuration = 300;
export const runtime = "nodejs";

const BUNDLED_INTERIM_GUIDANCE_FILES = [
  "Publication 1075 Interim Guidance - Authentication.txt",
  "Publication 1075 Interim Guidance - Data Incidents.txt",
  "Publication 1075 Interim Guidance - Disallowing Triple Data Encryption Algorithm (TDEA) and Triple Data Encryption Standard (3DES) for federal.txt",
];

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

function loadBundledInterimGuidanceInputs(importedById: string) {
  return BUNDLED_INTERIM_GUIDANCE_FILES.map((fileName) => {
    const filePath = join(process.cwd(), "public", fileName);
    const text = readFileSync(filePath, "utf-8");

    return inferInterimGuidanceInput({
      fileName,
      text,
      sourceName: fileName,
      importedById,
      metadata: {
        bundledExample: true,
        sourcePath: `public/${fileName}`,
        sourceType: INTERIM_GUIDANCE_SOURCE_TYPE,
      },
    });
  });
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

function formValue(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function inputFromUploadedFile(
  formData: FormData,
  importedById: string
) {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("A document file is required");
  }

  const uploadedAt = new Date().toISOString();
  const buffer = Buffer.from(await file.arrayBuffer());
  const fileName = file.name || "uploaded-document";
  const lowerName = fileName.toLowerCase();
  const isPdf =
    file.type === "application/pdf" ||
    lowerName.endsWith(".pdf") ||
    buffer.subarray(0, 4).equals(Buffer.from("%PDF"));
  const isText =
    file.type.startsWith("text/") ||
    [".txt", ".md", ".markdown", ".csv"].some((ext) => lowerName.endsWith(ext));
  const baseMetadata = parseMetadata(formValue(formData, "metadata")) || {};
  const sourceType = formValue(formData, "sourceType") || INTERIM_GUIDANCE_SOURCE_TYPE;

  let content: string;
  let extractedMetadata: Record<string, unknown> = {};

  if (isPdf) {
    const { text, pageCount, pdfInfo } = await extractPdfTextByPage(buffer);
    const pdfSha256 = hashText(buffer.toString("base64"));
    const textSha256 = hashText(text);
    content = [
      `# ${formValue(formData, "title") || fileName}`,
      `# Uploaded: ${uploadedAt}`,
      `# Source File: ${fileName}`,
      `# Total Pages: ${pageCount}`,
      `# PDF SHA256: ${pdfSha256}`,
      `# Text SHA256: ${textSha256}`,
      "",
      text,
    ].join("\n");
    extractedMetadata = {
      sourceFormat: "pdf",
      pageCount,
      pdfSizeKB: Math.round(buffer.length / 1024),
      pdfSha256,
      textSha256,
      pdfInfo,
    };
  } else if (isText) {
    const text = buffer.toString("utf-8");
    const textSha256 = hashText(text);
    content = text;
    extractedMetadata = {
      sourceFormat: lowerName.endsWith(".md") || lowerName.endsWith(".markdown") ? "markdown" : "text",
      textSizeKB: Math.round(buffer.length / 1024),
      textSha256,
    };
  } else {
    throw new Error("Unsupported file type. Upload PDF, TXT, MD, Markdown, or CSV files.");
  }

  const inferred =
    sourceType === INTERIM_GUIDANCE_SOURCE_TYPE
      ? inferInterimGuidanceInput({
          fileName,
          text: content,
          uploadedAt,
          metadata: baseMetadata,
          title: formValue(formData, "title"),
          sourceName: formValue(formData, "sourceName"),
          version: formValue(formData, "version"),
          description: formValue(formData, "description"),
          guidanceDate: formValue(formData, "guidanceDate"),
          effectiveDate: formValue(formData, "effectiveDate"),
          authority: formValue(formData, "authority"),
          importedById,
        })
      : null;

  return {
    ...inferred,
    title: formValue(formData, "title") || inferred?.title || fileName,
    content,
    sourceType,
    sourceName: formValue(formData, "sourceName") || inferred?.sourceName || fileName,
    version: formValue(formData, "version") || inferred?.version,
    description: formValue(formData, "description") || inferred?.description,
    importedById,
    metadata: {
      ...(inferred?.metadata || {}),
      ...baseMetadata,
      originalFileName: fileName,
      mimeType: file.type || "unknown",
      uploadedAt,
      supersedesOrAmendsPub1075:
        sourceType === INTERIM_GUIDANCE_SOURCE_TYPE,
      authority: formValue(formData, "authority") || inferred?.metadata?.authority || "Interim guidance",
      ...extractedMetadata,
    },
  };
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
    const contentType = request.headers.get("content-type") || "";
    const isMultipart = contentType.includes("multipart/form-data");
    const body = isMultipart ? null : await request.json();
    if (isMultipart) {
      const formData = await request.formData();
      const input = await inputFromUploadedFile(formData, user!.id);
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
          sourceName: input.sourceName,
          chunkCount: result.chunkCount,
          embeddedChunkCount: result.embeddedChunkCount,
          upload: true,
        },
        ipAddress:
          request.headers.get("x-forwarded-for") ||
          request.headers.get("x-real-ip") ||
          undefined,
        userAgent: request.headers.get("user-agent") || undefined,
      });

      return NextResponse.json({ success: true, ...result });
    }

    const action = body.action || "import_text";

    let syncDetails: Record<string, unknown> | undefined;
    let input;

    if (action === "import_bundled_interim_guidance") {
      const inputs = loadBundledInterimGuidanceInputs(user!.id);
      const imports = [];

      for (const input of inputs) {
        const result = await importKnowledgeDocument(input);
        imports.push({
          title: input.title,
          sourceType: input.sourceType,
          sourceName: input.sourceName,
          chunkCount: result.chunkCount,
          embeddedChunkCount: result.embeddedChunkCount,
          documentId: result.documentId,
          contentHash: result.contentHash,
        });
      }

      await logAudit({
        organizationId: user!.organizationId,
        userId: user!.id,
        action: "KNOWLEDGE_DOCUMENT_IMPORT",
        resourceType: "knowledge_document",
        metadata: {
          action,
          bundled: true,
          documents: imports,
          chunkCount: imports.reduce((total, item) => total + item.chunkCount, 0),
          embeddedChunkCount: imports.reduce(
            (total, item) => total + item.embeddedChunkCount,
            0
          ),
        },
        ipAddress:
          request.headers.get("x-forwarded-for") ||
          request.headers.get("x-real-ip") ||
          undefined,
        userAgent: request.headers.get("user-agent") || undefined,
      });

      return NextResponse.json({
        success: true,
        documentCount: imports.length,
        chunkCount: imports.reduce((total, item) => total + item.chunkCount, 0),
        embeddedChunkCount: imports.reduce(
          (total, item) => total + item.embeddedChunkCount,
          0
        ),
        documents: imports,
      });
    }

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
