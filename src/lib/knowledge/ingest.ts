import { Prisma } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/lib/db";
import { chunkKnowledgeDocument, hashText } from "@/lib/knowledge/chunking";
import { embedTextsInBatches, hasEmbeddingConfig, vectorLiteral } from "@/lib/knowledge/embeddings";

export const PUB_1075_PDF_URL = "https://www.irs.gov/pub/irs-pdf/p1075.pdf";

export interface KnowledgeImportInput {
  title: string;
  content: string;
  sourceType?: string;
  sourceName?: string;
  version?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  importedById?: string;
}

export interface KnowledgeImportResult {
  documentId: string;
  chunkCount: number;
  embeddedChunkCount: number;
  contentHash: string;
}

export function loadLocalPub1075(): KnowledgeImportInput {
  const filePath = join(process.cwd(), "data", "pub1075", "p1075-full-text.md");
  const content = readFileSync(filePath, "utf-8");

  return {
    title: "IRS Publication 1075",
    sourceType: "pub1075",
    sourceName: "p1075-full-text.md",
    version: "Rev. 11-2021",
    description: "Tax Information Security Guidelines for Federal, State, and Local Agencies",
    content,
    metadata: {
      sourcePath: "data/pub1075/p1075-full-text.md",
      sourceUrl: PUB_1075_PDF_URL,
    },
  };
}

function detectPub1075Version(text: string): string {
  const revMatch = text.match(/Publication\s+1075\s+\(Rev\.\s*([^)]+)\)/i);
  if (revMatch) return `Rev. ${revMatch[1].trim()}`;

  const headerMatch = text.match(/#\s*IRS Publication 1075[^\n]*\n#\s*Total Pages:/i);
  if (headerMatch) return "Current IRS PDF";

  return "Unknown revision";
}

async function extractPdfTextByPage(pdfBuffer: Buffer): Promise<{
  text: string;
  pageCount: number;
  pdfInfo: Record<string, unknown>;
}> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: pdfBuffer });

  try {
    const info = await parser.getInfo({ parsePageInfo: true });
    const pageCount = info.total || info.pages?.length || 0;
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await parser.getText({ partial: [pageNumber] });
      pages.push(`--- PAGE ${pageNumber} ---\n\n${page.text.trim()}`);
    }

    return {
      text: pages.join("\n\n\n"),
      pageCount,
      pdfInfo: {
        title: info.info?.Title,
        author: info.info?.Author,
        creator: info.info?.Creator,
        producer: info.info?.Producer,
        creationDate: info.info?.CreationDate,
        modificationDate: info.info?.ModDate,
      },
    };
  } finally {
    await parser.destroy();
  }
}

export async function loadOfficialPub1075FromIrs(): Promise<KnowledgeImportInput & {
  pdfSizeKB: number;
  pageCount: number;
  pdfSha256: string;
  textSha256: string;
  downloadedAt: string;
}> {
  const downloadedAt = new Date().toISOString();
  const response = await fetch(PUB_1075_PDF_URL, {
    headers: {
      "User-Agent": "IRS SkyShield Pub1075 Sync/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download Pub 1075 PDF: ${response.status} ${response.statusText}`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const pdfBuffer = Buffer.from(await response.arrayBuffer());

  if (!contentType.toLowerCase().includes("pdf") && !pdfBuffer.subarray(0, 4).equals(Buffer.from("%PDF"))) {
    throw new Error(`IRS response did not look like a PDF. Content-Type: ${contentType || "unknown"}`);
  }

  const { text, pageCount, pdfInfo } = await extractPdfTextByPage(pdfBuffer);
  const pdfSha256 = hashText(pdfBuffer.toString("base64"));
  const textSha256 = hashText(text);
  const version = detectPub1075Version(text);
  const header = [
    "# IRS Publication 1075 - Tax Information Security Guidelines",
    `# Total Pages: ${pageCount}`,
    `# Downloaded: ${downloadedAt}`,
    `# Source: ${PUB_1075_PDF_URL}`,
    `# PDF SHA256: ${pdfSha256}`,
    `# Text SHA256: ${textSha256}`,
    "",
    "",
  ].join("\n");
  const content = `${header}${text}`;

  return {
    title: "IRS Publication 1075",
    sourceType: "pub1075",
    sourceName: PUB_1075_PDF_URL,
    version,
    description: "Official IRS Publication 1075 PDF synced directly from IRS.gov",
    content,
    pdfSizeKB: Math.round(pdfBuffer.length / 1024),
    pageCount,
    pdfSha256,
    textSha256,
    downloadedAt,
    metadata: {
      sourceUrl: PUB_1075_PDF_URL,
      sourceFormat: "pdf",
      syncedFrom: "irs.gov",
      downloadedAt,
      pageCount,
      pdfSizeKB: Math.round(pdfBuffer.length / 1024),
      pdfSha256,
      textSha256,
      pdfInfo,
    },
  };
}

function jsonOrNull(metadata?: Record<string, unknown>) {
  return metadata ? Prisma.sql`${JSON.stringify(metadata)}::jsonb` : Prisma.sql`NULL`;
}

export async function importKnowledgeDocument(
  input: KnowledgeImportInput
): Promise<KnowledgeImportResult> {
  const normalizedContent = input.content.trim();
  if (!input.title.trim()) throw new Error("Document title is required");
  if (normalizedContent.length < 50) throw new Error("Document content is too short");

  const contentHash = hashText(normalizedContent);
  const chunks = chunkKnowledgeDocument(normalizedContent, input.metadata);
  const embeddings = hasEmbeddingConfig()
    ? await embedTextsInBatches(chunks.map((chunk) => chunk.content))
    : chunks.map(() => null);

  const embeddedChunkCount = embeddings.filter(Boolean).length;

  const document = await db.knowledgeDocument.upsert({
    where: { contentHash },
    create: {
      title: input.title.trim(),
      sourceType: input.sourceType || "document",
      sourceName: input.sourceName || null,
      version: input.version || null,
      description: input.description || null,
      metadata: input.metadata as Prisma.InputJsonValue,
      contentHash,
      status: "ACTIVE",
      chunkCount: chunks.length,
      importedById: input.importedById || null,
    },
    update: {
      title: input.title.trim(),
      sourceType: input.sourceType || "document",
      sourceName: input.sourceName || null,
      version: input.version || null,
      description: input.description || null,
      metadata: input.metadata as Prisma.InputJsonValue,
      status: "ACTIVE",
      chunkCount: chunks.length,
      importedById: input.importedById || null,
    },
  });

  await db.$transaction(async (tx) => {
    await tx.knowledgeChunk.deleteMany({ where: { documentId: document.id } });

    for (const [index, chunk] of chunks.entries()) {
      const embedding = embeddings[index];
      const embeddingSql = embedding
        ? Prisma.sql`${vectorLiteral(embedding)}::vector`
        : Prisma.sql`NULL`;

      await tx.$executeRaw(
        Prisma.sql`
          INSERT INTO "KnowledgeChunk" (
            "id",
            "documentId",
            "chunkIndex",
            "content",
            "pageStart",
            "pageEnd",
            "section",
            "heading",
            "metadata",
            "tokenCount",
            "contentHash",
            "embedding"
          ) VALUES (
            ${uuidv4()},
            ${document.id},
            ${chunk.chunkIndex},
            ${chunk.content},
            ${chunk.pageStart ?? null},
            ${chunk.pageEnd ?? null},
            ${chunk.section ?? null},
            ${chunk.heading ?? null},
            ${jsonOrNull(chunk.metadata)},
            ${chunk.tokenCount},
            ${chunk.contentHash},
            ${embeddingSql}
          )
        `
      );
    }
  });

  return {
    documentId: document.id,
    chunkCount: chunks.length,
    embeddedChunkCount,
    contentHash,
  };
}
