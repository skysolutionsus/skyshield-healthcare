import { db } from "@/lib/db";

export interface CrossRefDocument {
  documentId: string;
  title: string;
  sourceType: string;
  importedAt: Date;
  impactedControls: string[];
  impactedSections: string[];
  relationshipToPub1075: string | null;
  guidanceDate: string | null;
  effectiveDate: string | null;
}

export interface CrossRefIndex {
  byControl: Map<string, CrossRefDocument[]>;
  bySection: Map<string, CrossRefDocument[]>;
  documents: CrossRefDocument[];
}

const CACHE_TTL_MS = 60_000;

interface CachedIndex {
  index: CrossRefIndex;
  fetchedAt: number;
}

let cache: CachedIndex | null = null;

function asStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function normalizeControl(token: string): string {
  return token.trim().toUpperCase();
}

function normalizeSection(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return trimmed;
  return trimmed.replace(/^section\s+/i, "Section ");
}

export async function getCrossRefIndex(force = false): Promise<CrossRefIndex> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.index;
  }

  const docs = await db.knowledgeDocument.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      title: true,
      sourceType: true,
      importedAt: true,
      metadata: true,
    },
  });

  const byControl = new Map<string, CrossRefDocument[]>();
  const bySection = new Map<string, CrossRefDocument[]>();
  const documents: CrossRefDocument[] = [];

  for (const doc of docs) {
    const meta = (doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)
      ? (doc.metadata as Record<string, unknown>)
      : {});

    const crossRefDoc: CrossRefDocument = {
      documentId: doc.id,
      title: doc.title,
      sourceType: doc.sourceType,
      importedAt: doc.importedAt,
      impactedControls: asStringArray(meta.impactedControls).map(normalizeControl),
      impactedSections: asStringArray(meta.impactedPub1075Sections).map(normalizeSection),
      relationshipToPub1075: asStringOrNull(meta.relationshipToPub1075),
      guidanceDate: asStringOrNull(meta.guidanceDate),
      effectiveDate: asStringOrNull(meta.effectiveDate),
    };

    documents.push(crossRefDoc);

    for (const control of crossRefDoc.impactedControls) {
      const list = byControl.get(control) || [];
      list.push(crossRefDoc);
      byControl.set(control, list);
    }

    for (const section of crossRefDoc.impactedSections) {
      const list = bySection.get(section) || [];
      list.push(crossRefDoc);
      bySection.set(section, list);
    }
  }

  const index: CrossRefIndex = { byControl, bySection, documents };
  cache = { index, fetchedAt: Date.now() };
  return index;
}

export function findDocumentsForControls(
  index: CrossRefIndex,
  controls: string[]
): CrossRefDocument[] {
  const seen = new Set<string>();
  const results: CrossRefDocument[] = [];
  for (const control of controls) {
    const docs = index.byControl.get(normalizeControl(control)) || [];
    for (const doc of docs) {
      if (!seen.has(doc.documentId)) {
        seen.add(doc.documentId);
        results.push(doc);
      }
    }
  }
  return results;
}

export function formatCrossRefNotice(docs: CrossRefDocument[], controls: string[]): string {
  if (docs.length === 0 || controls.length === 0) return "";

  const lines = [
    `NOTICE: The following controls referenced in this query have impacting interim guidance or documents:`,
    ...docs.map((doc) => {
      const impactedHits = doc.impactedControls.filter((c) => controls.includes(c));
      const hitNote = impactedHits.length > 0 ? ` (impacts ${impactedHits.join(", ")})` : "";
      const dateNote = doc.guidanceDate ? ` — ${doc.guidanceDate}` : "";
      const relNote = doc.relationshipToPub1075 ? ` [${doc.relationshipToPub1075}]` : "";
      return `- ${doc.title}${hitNote}${dateNote}${relNote}`;
    }),
  ];
  return lines.join("\n");
}

export function invalidateCrossRefCache(): void {
  cache = null;
}
