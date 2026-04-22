import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { embedTexts, hasEmbeddingConfig, vectorLiteral } from "@/lib/knowledge/embeddings";

export interface RetrievedKnowledgeChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  sourceType: string;
  sourceName: string | null;
  version: string | null;
  documentMetadata: Record<string, unknown> | null;
  importedAt: Date;
  chunkIndex: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  heading: string | null;
  score: number;
  matchType: string;
}

function extractExactTerms(query: string): string[] {
  const terms = new Set<string>();
  const controls = query.match(/\b(?:AC|AT|AU|CA|CM|CP|IA|IR|MA|MP|PE|PL|PM|PS|PT|RA|SA|SC|SI|SR)-\d+(?:\([^)]+\))?\b/gi) || [];
  controls.forEach((term) => terms.add(term.toUpperCase()));

  const sections = query.match(/\bSection\s+\d+(?:\.[A-Z0-9]+)*(?:\.\d+)*\b/gi) || [];
  sections.forEach((term) => terms.add(term));

  const phrases = ["FIPS 140", "Publication 1075", "Federal Tax Information", "FTI"];
  for (const phrase of phrases) {
    if (query.toLowerCase().includes(phrase.toLowerCase())) terms.add(phrase);
  }

  return [...terms];
}

function mergeResults(
  groups: RetrievedKnowledgeChunk[][],
  limit: number
): RetrievedKnowledgeChunk[] {
  const byId = new Map<string, RetrievedKnowledgeChunk>();

  for (const group of groups) {
    for (const item of group) {
      const existing = byId.get(item.id);
      if (!existing || item.score > existing.score) {
        byId.set(item.id, item);
      } else if (existing.matchType !== item.matchType) {
        existing.matchType = `${existing.matchType}+${item.matchType}`;
      }
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function retrieveKnowledgeChunks(
  query: string,
  limit = 10
): Promise<RetrievedKnowledgeChunk[]> {
  const exactTerms = extractExactTerms(query);
  const exactConditions =
    exactTerms.length > 0
      ? Prisma.join(
          exactTerms.map(
            (term) => Prisma.sql`
              c."section" = ${term}
              OR c."heading" ILIKE ${`%${term}%`}
              OR c."content" ILIKE ${`%${term}%`}
            `
          ),
          " OR "
        )
      : Prisma.empty;

  const exactPromise =
    exactTerms.length > 0
      ? db.$queryRaw<RetrievedKnowledgeChunk[]>(
          Prisma.sql`
            SELECT
              c."id",
              c."documentId",
              d."title" AS "documentTitle",
              d."sourceType",
              d."sourceName",
              d."version",
              d."metadata" AS "documentMetadata",
              d."importedAt",
              c."chunkIndex",
              c."content",
              c."pageStart",
              c."pageEnd",
              c."section",
              c."heading",
              (100 + CASE WHEN d."sourceType" = 'interim_guidance' THEN 25 WHEN d."sourceType" = 'pub1075' THEN 10 ELSE 0 END)::double precision AS "score",
              'exact' AS "matchType"
            FROM "KnowledgeChunk" c
            JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
            WHERE d."status" = 'ACTIVE'
              AND (${exactConditions})
            ORDER BY
              CASE WHEN d."sourceType" = 'interim_guidance' THEN 0 WHEN d."sourceType" = 'pub1075' THEN 1 ELSE 2 END,
              d."importedAt" DESC,
              c."chunkIndex" ASC
            LIMIT ${limit}
          `
        )
      : Promise.resolve([]);

  const keywordPromise = db.$queryRaw<RetrievedKnowledgeChunk[]>(
    Prisma.sql`
      SELECT
        c."id",
        c."documentId",
        d."title" AS "documentTitle",
        d."sourceType",
        d."sourceName",
        d."version",
        d."metadata" AS "documentMetadata",
        d."importedAt",
        c."chunkIndex",
        c."content",
        c."pageStart",
        c."pageEnd",
        c."section",
        c."heading",
        (
          ts_rank_cd(c."searchVector", websearch_to_tsquery('english', ${query})) +
          CASE WHEN d."sourceType" = 'interim_guidance' THEN 0.5 WHEN d."sourceType" = 'pub1075' THEN 0.2 ELSE 0 END
        )::double precision AS "score",
        'keyword' AS "matchType"
      FROM "KnowledgeChunk" c
      JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
      WHERE d."status" = 'ACTIVE'
        AND c."searchVector" @@ websearch_to_tsquery('english', ${query})
      ORDER BY "score" DESC
      LIMIT ${limit}
    `
  );

  const vectorPromise = hasEmbeddingConfig()
    ? embedTexts([query]).then(([embedding]) => {
        if (!embedding) return [];
        return db.$queryRaw<RetrievedKnowledgeChunk[]>(
          Prisma.sql`
            SELECT
              c."id",
              c."documentId",
              d."title" AS "documentTitle",
              d."sourceType",
              d."sourceName",
              d."version",
              d."metadata" AS "documentMetadata",
              d."importedAt",
              c."chunkIndex",
              c."content",
              c."pageStart",
              c."pageEnd",
              c."section",
              c."heading",
              (
                1 - (c."embedding" <=> ${vectorLiteral(embedding)}::vector) +
                CASE WHEN d."sourceType" = 'interim_guidance' THEN 0.08 WHEN d."sourceType" = 'pub1075' THEN 0.03 ELSE 0 END
              )::double precision AS "score",
              'vector' AS "matchType"
            FROM "KnowledgeChunk" c
            JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
            WHERE d."status" = 'ACTIVE'
              AND c."embedding" IS NOT NULL
            ORDER BY c."embedding" <=> ${vectorLiteral(embedding)}::vector
            LIMIT ${limit}
          `
        );
      })
    : Promise.resolve([]);

  const [exact, keyword, vector] = await Promise.all([
    exactPromise,
    keywordPromise,
    vectorPromise,
  ]);

  return mergeResults([exact, keyword, vector], limit);
}

export function formatKnowledgeContext(chunks: RetrievedKnowledgeChunk[]): string {
  if (chunks.length === 0) {
    return "No relevant knowledge-base excerpts were retrieved.";
  }

  return chunks
    .map((chunk, index) => {
      const guidanceDate = metadataValue(chunk.documentMetadata, "guidanceDate");
      const effectiveDate = metadataValue(chunk.documentMetadata, "effectiveDate");
      const authority = metadataValue(chunk.documentMetadata, "authority");
      const location = [
        chunk.section,
        chunk.heading,
        chunk.pageStart ? `page ${chunk.pageStart}${chunk.pageEnd && chunk.pageEnd !== chunk.pageStart ? `-${chunk.pageEnd}` : ""}` : null,
      ]
        .filter(Boolean)
        .join(" | ");

      return `--- KNOWLEDGE EXCERPT ${index + 1} ---
Document: ${chunk.documentTitle}${chunk.version ? ` (${chunk.version})` : ""}
Source type: ${chunk.sourceType}
Source name: ${chunk.sourceName || "not specified"}
Imported: ${chunk.importedAt instanceof Date ? chunk.importedAt.toISOString() : chunk.importedAt}
${guidanceDate ? `Guidance date: ${guidanceDate}\n` : ""}${effectiveDate ? `Effective date: ${effectiveDate}\n` : ""}${authority ? `Authority: ${authority}\n` : ""}Location: ${location || `chunk ${chunk.chunkIndex}`}
Match: ${chunk.matchType}
Chunk ID: ${chunk.id}

${chunk.content}`;
    })
    .join("\n\n");
}

function metadataValue(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key];
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}
