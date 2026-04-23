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

interface SectionBlock {
  sectionNumber?: string;
  sectionTitle?: string;
  pages: PageBlock[];
}

// Tuned for Pub 1075 compliance retrieval precision.
// Smaller chunks → better rerank precision; 250-char overlap preserves
// boundary context for citations and control IDs.
const TARGET_CHARS = 1_600;
const OVERLAP_CHARS = 250;
const HARD_MAX_CHARS = 2_400;

// Matches Pub 1075 section labels like "2.B.3.1 Visitor Access Logs" or
// "4.7 Cloud Computing Environment". Requires at least one sub-level to avoid
// matching plain numeric list items.
const SECTION_HEADING_REGEX =
  /^\s*(\d+(?:\.[A-Z0-9]+){1,6})\s+([A-Z][A-Za-z0-9 ,:/&()'\-_–—]{3,200})\s*$/;

// Inline "Section X.Y.Z" reference within flowing text.
const SECTION_REFERENCE_REGEX = /\bSection\s+(\d+(?:\.[A-Z0-9]+)*(?:\.\d+)*)\b/i;

// NIST 800-53 control IDs.
const CONTROL_REGEX =
  /\b(?:AC|AT|AU|CA|CM|CP|IA|IR|MA|MP|PE|PL|PM|PS|PT|RA|SA|SC|SI|SR)-\d+(?:\([^)]+\))?\b/i;

const EXHIBIT_REGEX = /\bExhibit\s+\d+\b/i;

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

/**
 * Group pages into section blocks by detecting Pub 1075 section headings.
 * If no section headings are found (e.g., for interim guidance docs), the
 * whole document is returned as a single untitled section block.
 */
function groupIntoSectionBlocks(pages: PageBlock[]): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  let current: SectionBlock = { pages: [] };

  for (const page of pages) {
    const lines = page.content.split("\n");
    let buffer: string[] = [];

    const flushBuffer = (targetBlock: SectionBlock) => {
      if (buffer.length === 0) return;
      const content = buffer.join("\n").trim();
      if (content) {
        targetBlock.pages.push({ page: page.page, content });
      }
      buffer = [];
    };

    for (const line of lines) {
      const headingMatch = line.match(SECTION_HEADING_REGEX);
      if (headingMatch) {
        flushBuffer(current);
        if (current.pages.length > 0 || current.sectionNumber) {
          blocks.push(current);
        }
        current = {
          sectionNumber: headingMatch[1],
          sectionTitle: headingMatch[2].trim(),
          pages: [],
        };
      } else {
        buffer.push(line);
      }
    }

    flushBuffer(current);
  }

  if (current.pages.length > 0 || current.sectionNumber) {
    blocks.push(current);
  }

  return blocks.filter((block) => block.pages.length > 0);
}

function detectSection(content: string, parentSection?: string): string | undefined {
  const control = content.match(CONTROL_REGEX);
  if (control) return control[0].toUpperCase();

  const section = content.match(SECTION_REFERENCE_REGEX);
  if (section) return `Section ${section[1]}`;

  const exhibit = content.match(EXHIBIT_REGEX);
  if (exhibit) return exhibit[0];

  if (parentSection) return `Section ${parentSection}`;
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
  parent: { sectionNumber?: string; sectionTitle?: string } | undefined,
  documentMetadata?: Record<string, unknown>
): KnowledgeChunkInput {
  const trimmed = content.trim();
  const pageNumbers = pages.filter((page): page is number => typeof page === "number");
  const section = detectSection(trimmed, parent?.sectionNumber);

  const chunkMetadata: Record<string, unknown> = {
    ...(documentMetadata || {}),
  };

  if (parent?.sectionNumber) {
    chunkMetadata.parentSectionNumber = parent.sectionNumber;
  }
  if (parent?.sectionTitle) {
    chunkMetadata.parentSectionTitle = parent.sectionTitle;
  }

  return {
    chunkIndex,
    content: trimmed,
    pageStart: pageNumbers.length > 0 ? Math.min(...pageNumbers) : undefined,
    pageEnd: pageNumbers.length > 0 ? Math.max(...pageNumbers) : undefined,
    section,
    heading: detectHeading(trimmed, section) ||
      (parent?.sectionTitle && parent?.sectionNumber
        ? `${parent.sectionNumber} ${parent.sectionTitle}`.slice(0, 180)
        : undefined),
    tokenCount: estimateTokens(trimmed),
    contentHash: hashText(trimmed),
    metadata: Object.keys(chunkMetadata).length > 0 ? chunkMetadata : undefined,
  };
}

/**
 * Split a single section block into overlapping chunks. Each chunk inherits
 * the parent section metadata so the retrieval layer can surface "this chunk
 * belongs to Section X.Y.Z" to the LLM without loading the entire parent.
 */
function chunkSectionBlock(
  block: SectionBlock,
  startIndex: number,
  documentMetadata?: Record<string, unknown>
): KnowledgeChunkInput[] {
  const chunks: KnowledgeChunkInput[] = [];
  let buffer = "";
  let bufferPages: Array<number | undefined> = [];

  const parent = block.sectionNumber
    ? { sectionNumber: block.sectionNumber, sectionTitle: block.sectionTitle }
    : undefined;

  const flush = (force = false) => {
    if (!buffer.trim()) return;
    if (!force && buffer.length < 200) return;
    chunks.push(
      makeChunk(startIndex + chunks.length, buffer, bufferPages, parent, documentMetadata)
    );
    const overlap = buffer.slice(-OVERLAP_CHARS);
    buffer = overlap.trim();
    bufferPages = buffer ? bufferPages.slice(-2) : [];
  };

  for (const page of block.pages) {
    const paragraphs = page.content.split(/\n{2,}/g).filter((part) => part.trim());

    for (const paragraph of paragraphs) {
      const trimmedPara = paragraph.trim();
      const next = buffer ? `${buffer}\n\n${trimmedPara}` : trimmedPara;

      if (next.length > TARGET_CHARS && buffer.length > 0) {
        flush();
      }

      buffer = buffer ? `${buffer}\n\n${trimmedPara}` : trimmedPara;
      if (!bufferPages.includes(page.page)) bufferPages.push(page.page);

      if (buffer.length >= HARD_MAX_CHARS) {
        flush(true);
      } else if (buffer.length >= TARGET_CHARS) {
        flush();
      }
    }
  }

  if (buffer.trim().length > OVERLAP_CHARS || chunks.length === 0) {
    chunks.push(
      makeChunk(startIndex + chunks.length, buffer, bufferPages, parent, documentMetadata)
    );
  }

  return chunks.filter((chunk) => chunk.content.length > 0);
}

export function chunkKnowledgeDocument(
  content: string,
  metadata?: Record<string, unknown>
): KnowledgeChunkInput[] {
  const pages = splitPages(content);
  const sectionBlocks = groupIntoSectionBlocks(pages);

  const chunks: KnowledgeChunkInput[] = [];
  for (const block of sectionBlocks) {
    chunks.push(...chunkSectionBlock(block, chunks.length, metadata));
  }

  return chunks;
}
