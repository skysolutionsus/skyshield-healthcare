import { Prisma } from "@prisma/client";
import { execFile } from "child_process";
import { readFileSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
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
  const tempDir = await mkdtemp(join(tmpdir(), "pub1075-"));
  const pdfPath = join(tempDir, "p1075.pdf");
  const textPath = join(tempDir, "p1075.txt");
  try {
    await writeFile(pdfPath, pdfBuffer);
    await runPdfToText(pdfPath, textPath);

    const rawText = await readFile(textPath, "utf-8");
    const pages = rawText
      .split("\f")
      .map((page) => page.trim())
      .filter(Boolean);
    const pageCount = pages.length || 1;

    return {
      text: pages
        .map((page, index) => `--- PAGE ${index + 1} ---\n\n${page}`)
        .join("\n\n\n"),
      pageCount,
      pdfInfo: {
        extractionTool: "pdftotext",
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runPdfToText(pdfPath: string, textPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "pdftotext",
      ["-layout", "-enc", "UTF-8", pdfPath, textPath],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }

        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === "ENOENT") {
          reject(
            new Error(
              "The pdftotext binary is not available. Redeploy with the updated Dockerfile so poppler-utils is installed in the app container."
            )
          );
          return;
        }

        reject(new Error(`pdftotext failed: ${stderr.trim() || error.message}`));
      }
    );
  });
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
