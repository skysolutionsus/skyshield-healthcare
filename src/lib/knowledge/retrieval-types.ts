export interface RetrievedKnowledgeChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  sourceType: string;
  sourceName: string | null;
  version: string | null;
  documentMetadata: Record<string, unknown> | null;
  chunkMetadata: Record<string, unknown> | null;
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
