import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { embedTexts, hasEmbeddingConfig, vectorLiteral } from "@/lib/knowledge/embeddings";
import {
  findDocumentsForControls,
  formatCrossRefNotice,
  getCrossRefIndex,
  type CrossRefDocument,
} from "@/lib/knowledge/crossref";
import { expandQuery } from "@/lib/knowledge/query-expansion";
import { rerankChunks, hasRerankConfig } from "@/lib/knowledge/rerank";
import type { RetrievedKnowledgeChunk } from "@/lib/knowledge/retrieval-types";

export type { RetrievedKnowledgeChunk } from "@/lib/knowledge/retrieval-types";

// NOTE on role-based filtering: `Role` (ADMIN, COMPUTER_SECURITY_REVIEW, etc.)
// gates access to admin UIs and some mutation endpoints, but retrieval intentionally
// returns the same Pub 1075 / interim guidance corpus to every authenticated user.
// All authenticated roles legitimately need access to the compliance knowledge base.
// If a future corpus adds agency-restricted material, add a role filter at the SQL level.

export interface KnowledgeRetrievalResult {
  chunks: RetrievedKnowledgeChunk[];
  expansion: {
    extractedControls: string[];
    addedTerms: string[];
  };
  crossReferencedDocs: CrossRefDocument[];
  crossRefNotice: string;
  rerankApplied: boolean;
}

function extractExactTerms(query: string, additionalControls: string[] = []): string[] {
  const terms = new Set<string>();
  const controls = query.match(/\b(?:AC|AT|AU|CA|CM|CP|IA|IR|MA|MP|PE|PL|PM|PS|PT|RA|SA|SC|SI|SR)-\d+(?:\([^)]+\))?\b/gi) || [];
  controls.forEach((term) => terms.add(term.toUpperCase()));
  additionalControls.forEach((term) => terms.add(term.toUpperCase()));

  const sections = query.match(/\bSection\s+\d+(?:\.[A-Z0-9]+)*(?:\.\d+)*\b/gi) || [];
  sections.forEach((term) => terms.add(term));

  const phrases = ["FIPS 140", "Publication 1075", "Federal Tax Information", "FTI"];
  for (const phrase of phrases) {
    if (query.toLowerCase().includes(phrase.toLowerCase())) terms.add(phrase);
  }

  return [...terms];
}

const DOCUMENT_QUERY_STOP_WORDS = new Set([
  "about",
  "does",
  "guidance",
  "interim",
  "publication",
  "pub",
  "say",
  "says",
  "the",
  "what",
]);

function extractDocumentMatchTerms(query: string): string[] {
  return [
    ...new Set(
      (query.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter(
        (term) => !DOCUMENT_QUERY_STOP_WORDS.has(term)
      )
    ),
  ].slice(0, 6);
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

/**
 * Low-level candidate retrieval — runs the 4-way hybrid (exact, title, keyword, vector)
 * and merges. This is the recall stage; precision is handled by `retrieveKnowledgeChunks`
 * which adds reranking on top.
 */
async function retrieveCandidates(
  searchQuery: string,
  additionalControls: string[],
  limit: number
): Promise<RetrievedKnowledgeChunk[]> {
  const exactTerms = extractExactTerms(searchQuery, additionalControls);
  const documentTerms = extractDocumentMatchTerms(searchQuery);
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
  const documentMatchConditions =
    documentTerms.length > 0
      ? Prisma.join(
          documentTerms.map(
            (term) => Prisma.sql`
              (
                d."title" ILIKE ${`%${term}%`}
                OR coalesce(d."sourceName", '') ILIKE ${`%${term}%`}
                OR coalesce(d."description", '') ILIKE ${`%${term}%`}
                OR coalesce(d."metadata"->>'subject', '') ILIKE ${`%${term}%`}
                OR c."content" ILIKE ${`%${term}%`}
              )
            `
          ),
          " AND "
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
              c."metadata" AS "chunkMetadata",
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

  const documentPromise =
    documentTerms.length > 0
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
              c."metadata" AS "chunkMetadata",
              d."importedAt",
              c."chunkIndex",
              c."content",
              c."pageStart",
              c."pageEnd",
              c."section",
              c."heading",
              (140 + CASE WHEN d."sourceType" = 'interim_guidance' THEN 30 WHEN d."sourceType" = 'pub1075' THEN 10 ELSE 0 END)::double precision AS "score",
              'document-title' AS "matchType"
            FROM "KnowledgeChunk" c
            JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
            WHERE d."status" = 'ACTIVE'
              AND (${documentMatchConditions})
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
          ts_rank_cd(c."searchVector", websearch_to_tsquery('english', ${searchQuery})) +
          CASE WHEN d."sourceType" = 'interim_guidance' THEN 0.5 WHEN d."sourceType" = 'pub1075' THEN 0.2 ELSE 0 END
        )::double precision AS "score",
        'keyword' AS "matchType"
      FROM "KnowledgeChunk" c
      JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
      WHERE d."status" = 'ACTIVE'
        AND c."searchVector" @@ websearch_to_tsquery('english', ${searchQuery})
      ORDER BY "score" DESC
      LIMIT ${limit}
    `
  );

  const vectorPromise = hasEmbeddingConfig()
    ? embedTexts([searchQuery]).then(([embedding]) => {
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
              c."metadata" AS "chunkMetadata",
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

  const [exact, document, keyword, vector] = await Promise.all([
    exactPromise,
    documentPromise,
    keywordPromise,
    vectorPromise,
  ]);

  return mergeResults([exact, document, keyword, vector], limit);
}

/**
 * Full retrieval pipeline: query expansion → over-fetch hybrid candidates →
 * reranker (if configured) → crossref enrichment.
 *
 * Defaults tuned for Pub 1075 compliance Q&A — callers typically want the
 * structured `retrieveKnowledgeContext` which includes crossref metadata for
 * the LLM prompt.
 */
export async function retrieveKnowledgeContext(
  query: string,
  limit = 10
): Promise<KnowledgeRetrievalResult> {
  const expansion = expandQuery(query);

  const candidateLimit = Math.max(limit, hasRerankConfig() ? 30 : limit);
  const candidates = await retrieveCandidates(
    expansion.expandedQuery,
    expansion.extractedControls,
    candidateLimit
  );

  const rerankApplied = hasRerankConfig() && candidates.length > limit;
  const reranked = rerankApplied
    ? await rerankChunks(expansion.originalQuery, candidates, limit)
    : candidates.slice(0, limit);

  let crossReferencedDocs: CrossRefDocument[] = [];
  let crossRefNotice = "";
  if (expansion.extractedControls.length > 0) {
    try {
      const index = await getCrossRefIndex();
      crossReferencedDocs = findDocumentsForControls(index, expansion.extractedControls);
      crossRefNotice = formatCrossRefNotice(crossReferencedDocs, expansion.extractedControls);
    } catch (err) {
      console.warn("Cross-reference lookup failed:", err);
    }
  }

  return {
    chunks: reranked,
    expansion: {
      extractedControls: expansion.extractedControls,
      addedTerms: expansion.addedTerms,
    },
    crossReferencedDocs,
    crossRefNotice,
    rerankApplied,
  };
}

/**
 * Thin wrapper kept for callers that only need chunks (backwards compatible).
 */
export async function retrieveKnowledgeChunks(
  query: string,
  limit = 10
): Promise<RetrievedKnowledgeChunk[]> {
  const result = await retrieveKnowledgeContext(query, limit);
  return result.chunks;
}

export function formatKnowledgeContext(
  chunks: RetrievedKnowledgeChunk[],
  crossRefNotice = ""
): string {
  if (chunks.length === 0) {
    return "No relevant knowledge-base excerpts were retrieved.";
  }

  const body = chunks
    .map((chunk, index) => {
      const guidanceDate = metadataValue(chunk.documentMetadata, "guidanceDate");
      const effectiveDate = metadataValue(chunk.documentMetadata, "effectiveDate");
      const authority = metadataValue(chunk.documentMetadata, "authority");
      const chunkMeta = readChunkMetadata(chunk);
      const parentSectionNumber = chunkMeta?.parentSectionNumber;
      const parentSectionTitle = chunkMeta?.parentSectionTitle;
      const parentLabel =
        parentSectionNumber && parentSectionTitle
          ? `${parentSectionNumber} ${parentSectionTitle}`
          : parentSectionNumber || parentSectionTitle || null;

      const location = [
        parentLabel ? `Section ${parentLabel}` : chunk.section,
        chunk.heading && chunk.heading !== parentLabel ? chunk.heading : null,
        chunk.pageStart
          ? `page ${chunk.pageStart}${chunk.pageEnd && chunk.pageEnd !== chunk.pageStart ? `-${chunk.pageEnd}` : ""}`
          : null,
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

  return crossRefNotice ? `${crossRefNotice}\n\n${body}` : body;
}

/**
 * Fetch chunks adjacent (previous / next chunkIndex) to each input chunk.
 * Used to expand context for retrieved children — the LLM sees the neighbor
 * paragraphs without re-running retrieval.
 */
export async function expandWithNeighbors(
  chunks: RetrievedKnowledgeChunk[],
  radius = 1
): Promise<RetrievedKnowledgeChunk[]> {
  if (chunks.length === 0 || radius <= 0) return chunks;

  const existingIds = new Set(chunks.map((c) => c.id));
  const ranges = new Map<string, Set<number>>();

  for (const chunk of chunks) {
    const wanted = ranges.get(chunk.documentId) || new Set<number>();
    for (let offset = 1; offset <= radius; offset += 1) {
      if (chunk.chunkIndex - offset >= 0) wanted.add(chunk.chunkIndex - offset);
      wanted.add(chunk.chunkIndex + offset);
    }
    ranges.set(chunk.documentId, wanted);
  }

  const fetchPromises: Promise<RetrievedKnowledgeChunk[]>[] = [];
  for (const [documentId, indexes] of ranges.entries()) {
    if (indexes.size === 0) continue;
    const indexList = [...indexes];
    fetchPromises.push(
      db.$queryRaw<RetrievedKnowledgeChunk[]>(
        Prisma.sql`
          SELECT
            c."id",
            c."documentId",
            d."title" AS "documentTitle",
            d."sourceType",
            d."sourceName",
            d."version",
            d."metadata" AS "documentMetadata",
            c."metadata" AS "chunkMetadata",
            d."importedAt",
            c."chunkIndex",
            c."content",
            c."pageStart",
            c."pageEnd",
            c."section",
            c."heading",
            0::double precision AS "score",
            'neighbor' AS "matchType"
          FROM "KnowledgeChunk" c
          JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
          WHERE c."documentId" = ${documentId}
            AND c."chunkIndex" IN (${Prisma.join(indexList)})
            AND d."status" = 'ACTIVE'
        `
      )
    );
  }

  const neighborGroups = await Promise.all(fetchPromises);
  const additions: RetrievedKnowledgeChunk[] = [];
  for (const group of neighborGroups) {
    for (const neighbor of group) {
      if (!existingIds.has(neighbor.id)) {
        existingIds.add(neighbor.id);
        additions.push(neighbor);
      }
    }
  }

  const combined = [...chunks, ...additions];
  combined.sort((a, b) => {
    if (a.documentId !== b.documentId) {
      return a.documentTitle.localeCompare(b.documentTitle);
    }
    return a.chunkIndex - b.chunkIndex;
  });
  return combined;
}

function metadataValue(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key];
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function readChunkMetadata(
  chunk: RetrievedKnowledgeChunk
): { parentSectionNumber?: string; parentSectionTitle?: string } | null {
  const meta = chunk.chunkMetadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  const parentSectionNumber =
    typeof record.parentSectionNumber === "string" ? record.parentSectionNumber : undefined;
  const parentSectionTitle =
    typeof record.parentSectionTitle === "string" ? record.parentSectionTitle : undefined;
  if (!parentSectionNumber && !parentSectionTitle) return null;
  return { parentSectionNumber, parentSectionTitle };
}
