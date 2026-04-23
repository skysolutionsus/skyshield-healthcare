import type { RetrievedKnowledgeChunk } from "@/lib/knowledge/retrieval-types";

const DEFAULT_COHERE_MODEL = "rerank-v3.5";
const COHERE_RERANK_URL = "https://api.cohere.com/v2/rerank";
const RERANK_TIMEOUT_MS = 8_000;
const MAX_DOCUMENT_CHARS = 2_400;

export function hasRerankConfig(): boolean {
  return Boolean(process.env.COHERE_API_KEY) && process.env.RERANK_PROVIDER !== "none";
}

function truncate(text: string, max = MAX_DOCUMENT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function buildDocumentText(chunk: RetrievedKnowledgeChunk): string {
  const header = [
    chunk.documentTitle,
    chunk.sourceType === "interim_guidance" ? "[INTERIM GUIDANCE]" : null,
    chunk.section,
    chunk.heading,
  ]
    .filter(Boolean)
    .join(" | ");

  return truncate(`${header}\n${chunk.content}`);
}

export async function rerankChunks(
  query: string,
  chunks: RetrievedKnowledgeChunk[],
  topN: number
): Promise<RetrievedKnowledgeChunk[]> {
  if (chunks.length === 0) return chunks;
  if (!hasRerankConfig()) return chunks.slice(0, topN);

  const apiKey = process.env.COHERE_API_KEY!;
  const model = process.env.COHERE_RERANK_MODEL || DEFAULT_COHERE_MODEL;
  const documents = chunks.map(buildDocumentText);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);

  try {
    const response = await fetch(COHERE_RERANK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents,
        top_n: Math.min(topN, documents.length),
        return_documents: false,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(`Rerank request failed (${response.status}): ${detail.slice(0, 200)}`);
      return chunks.slice(0, topN);
    }

    const data = (await response.json()) as {
      results?: Array<{ index: number; relevance_score: number }>;
    };

    if (!data.results || data.results.length === 0) {
      return chunks.slice(0, topN);
    }

    const reranked: RetrievedKnowledgeChunk[] = [];
    for (const result of data.results) {
      const original = chunks[result.index];
      if (!original) continue;
      reranked.push({
        ...original,
        score: result.relevance_score,
        matchType: `${original.matchType}+rerank`,
      });
    }

    return reranked.length > 0 ? reranked : chunks.slice(0, topN);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Rerank skipped: ${reason}`);
    return chunks.slice(0, topN);
  } finally {
    clearTimeout(timer);
  }
}
