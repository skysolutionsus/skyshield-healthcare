import Anthropic from "@anthropic-ai/sdk";
import {
  expandWithNeighbors,
  formatKnowledgeContext,
  retrieveKnowledgeContext,
} from "@/lib/knowledge/retrieval";

export const KNOWLEDGE_SEARCH_TOOL: Anthropic.Tool = {
  name: "knowledge_search",
  description:
    "Search the IRS Publication 1075 and interim guidance knowledge base. " +
    "Use this to find specific Pub 1075 sections, NIST 800-53 controls (e.g., SC-28, IA-5), or interim guidance that supersedes the baseline. " +
    "Call this multiple times with different queries when a question requires multiple facets — e.g., first search for the baseline Pub 1075 section, then search for any interim guidance that impacts it. " +
    "Prefer concrete terms (control IDs, section numbers, key phrases like 'encryption at rest') over vague natural language. " +
    "Returns formatted excerpts with source attribution (Pub 1075 baseline vs. interim guidance), section labels, page ranges, and cross-reference notices for impacting interim guidance.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search query. Can be a natural language question, specific control IDs (e.g., 'SC-28'), section numbers ('Section 4.7.1'), or keywords.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of excerpts to return. Default 8. Range 1-15.",
      },
      expand_neighbors: {
        type: "boolean",
        description:
          "If true, include chunks adjacent to each retrieved result for extra context. Default false. Use true when the top result is a short fragment.",
      },
    },
    required: ["query"],
  },
};

export interface KnowledgeSearchInput {
  query: string;
  limit?: number;
  expand_neighbors?: boolean;
}

export interface KnowledgeSearchOutcome {
  content: string;
  chunkCount: number;
  rerankApplied: boolean;
  extractedControls: string[];
  crossReferencedDocIds: string[];
}

export async function handleKnowledgeSearch(
  input: KnowledgeSearchInput
): Promise<KnowledgeSearchOutcome> {
  const query = (input.query || "").trim();
  if (!query) {
    return {
      content: "ERROR: knowledge_search requires a non-empty query parameter.",
      chunkCount: 0,
      rerankApplied: false,
      extractedControls: [],
      crossReferencedDocIds: [],
    };
  }

  const limit = clampInt(input.limit ?? 8, 1, 15);

  try {
    const result = await retrieveKnowledgeContext(query, limit);
    const chunks = input.expand_neighbors
      ? await expandWithNeighbors(result.chunks, 1)
      : result.chunks;

    const formatted = formatKnowledgeContext(chunks, result.crossRefNotice);

    const header = [
      `Query: ${query}`,
      result.expansion.extractedControls.length > 0
        ? `Controls detected in query: ${result.expansion.extractedControls.join(", ")}`
        : null,
      result.expansion.addedTerms.length > 0
        ? `Related terms searched: ${result.expansion.addedTerms.join(", ")}`
        : null,
      `Reranked: ${result.rerankApplied ? "yes" : "no"}`,
      `Chunks returned: ${chunks.length}`,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: `${header}\n\n${formatted}`,
      chunkCount: chunks.length,
      rerankApplied: result.rerankApplied,
      extractedControls: result.expansion.extractedControls,
      crossReferencedDocIds: result.crossReferencedDocs.map((d) => d.documentId),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      content: `knowledge_search failed: ${reason}. The retrieval service may be temporarily unavailable. You may answer using any general Pub 1075 knowledge you were given in the system prompt, but explicitly note that live retrieval was unavailable for this query.`,
      chunkCount: 0,
      rerankApplied: false,
      extractedControls: [],
      crossReferencedDocIds: [],
    };
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
