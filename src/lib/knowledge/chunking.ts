import { createHash } from "crypto";

export interface KnowledgeChunkInput {
  chunkIndex: number;
  content: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  heading?: string;
  tokenCount: number;
  contentHash: string;
  metadata?: Record<string, unknown>;
}

interface PageBlock {
  page?: number;
  content: string;
}

const TARGET_CHARS = 4200;
const OVERLAP_CHARS = 500;

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function splitPages(text: string): PageBlock[] {
  const normalized = normalizeText(text);
  const parts = normalized.split(/\n--- PAGE (\d+) ---\n/g);

  if (parts.length === 1) {
    return [{ content: normalized }];
  }

  const pages: PageBlock[] = [];
  if (parts[0]?.trim()) {
    pages.push({ content: parts[0].trim() });
  }

  for (let i = 1; i < parts.length; i += 2) {
    pages.push({
      page: Number(parts[i]),
      content: parts[i + 1]?.trim() || "",
    });
  }

  return pages.filter((page) => page.content.length > 0);
}

function detectSection(content: string): string | undefined {
  const control = content.match(
    /\b(?:AC|AT|AU|CA|CM|CP|IA|IR|MA|MP|PE|PL|PM|PS|PT|RA|SA|SC|SI|SR)-\d+(?:\([^)]+\))?\b/i
  );
  if (control) return control[0].toUpperCase();

  const section = content.match(/\bSection\s+(\d+(?:\.[A-Z0-9]+)*(?:\.\d+)*)\b/i);
  if (section) return `Section ${section[1]}`;

  const exhibit = content.match(/\bExhibit\s+\d+\b/i);
  if (exhibit) return exhibit[0];

  return undefined;
}

function detectHeading(content: string, section?: string): string | undefined {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (section) {
    const sectionLine = lines.find((line) =>
      line.toLowerCase().startsWith(section.toLowerCase())
    );
    if (sectionLine) return sectionLine.slice(0, 180);
  }

  return lines.find((line) => {
    if (line.length > 180) return false;
    if (/^[-*_]+$/.test(line)) return false;
    return /[A-Za-z]/.test(line);
  });
}

function makeChunk(
  chunkIndex: number,
  content: string,
  pages: Array<number | undefined>,
  metadata?: Record<string, unknown>
): KnowledgeChunkInput {
  const trimmed = content.trim();
  const pageNumbers = pages.filter((page): page is number => typeof page === "number");
  const section = detectSection(trimmed);

  return {
    chunkIndex,
    content: trimmed,
    pageStart: pageNumbers.length > 0 ? Math.min(...pageNumbers) : undefined,
    pageEnd: pageNumbers.length > 0 ? Math.max(...pageNumbers) : undefined,
    section,
    heading: detectHeading(trimmed, section),
    tokenCount: estimateTokens(trimmed),
    contentHash: hashText(trimmed),
    metadata,
  };
}

export function chunkKnowledgeDocument(
  content: string,
  metadata?: Record<string, unknown>
): KnowledgeChunkInput[] {
  const pages = splitPages(content);
  const chunks: KnowledgeChunkInput[] = [];
  let buffer = "";
  let bufferPages: Array<number | undefined> = [];

  const flush = () => {
    if (!buffer.trim()) return;
    chunks.push(makeChunk(chunks.length, buffer, bufferPages, metadata));
    const overlap = buffer.slice(-OVERLAP_CHARS);
    buffer = overlap.trim();
    bufferPages = buffer ? bufferPages.slice(-2) : [];
  };

  for (const page of pages) {
    const paragraphs = page.content.split(/\n{2,}/g).filter((part) => part.trim());

    for (const paragraph of paragraphs) {
      const next = buffer ? `${buffer}\n\n${paragraph.trim()}` : paragraph.trim();
      if (next.length > TARGET_CHARS && buffer.length > 0) {
        flush();
      }

      buffer = buffer ? `${buffer}\n\n${paragraph.trim()}` : paragraph.trim();
      if (!bufferPages.includes(page.page)) bufferPages.push(page.page);

      if (buffer.length >= TARGET_CHARS) {
        flush();
      }
    }
  }

  if (buffer.trim().length > OVERLAP_CHARS || chunks.length === 0) {
    chunks.push(makeChunk(chunks.length, buffer, bufferPages, metadata));
  }

  return chunks.filter((chunk) => chunk.content.length > 0);
}
