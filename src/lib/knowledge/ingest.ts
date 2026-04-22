import { Prisma } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/lib/db";
import { chunkKnowledgeDocument, hashText } from "@/lib/knowledge/chunking";
import { embedTextsInBatches, hasEmbeddingConfig, vectorLiteral } from "@/lib/knowledge/embeddings";

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
      sourceUrl: "https://www.irs.gov/pub/irs-pdf/p1075.pdf",
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
