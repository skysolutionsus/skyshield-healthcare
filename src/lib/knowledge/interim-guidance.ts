import type { KnowledgeImportInput } from "@/lib/knowledge/ingest";

export const INTERIM_GUIDANCE_SOURCE_TYPE = "interim_guidance";

interface InterimGuidanceInferenceInput {
  fileName: string;
  text: string;
  uploadedAt?: string;
  metadata?: Record<string, unknown>;
  title?: string;
  sourceName?: string;
  version?: string;
  description?: string;
  guidanceDate?: string;
  effectiveDate?: string;
  authority?: string;
  importedById?: string;
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find(Boolean);
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function matchLine(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, "im"));
  return match ? normalizeWhitespace(match[1]) : undefined;
}

function toIsoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    values.add(normalizeWhitespace(match[0]));
  }
  return [...values];
}

function extractEffectiveDate(text: string): string | undefined {
  const match = text.match(
    /\bEffective\s+(?:as\s+of\s+)?([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\b/
  );
  return toIsoDate(match?.[1]);
}

function extractResources(text: string): string[] {
  const lines = text.split(/\r?\n/g);
  const resources: string[] = [];
  let capturing = false;

  for (const line of lines) {
    const trimmed = normalizeWhitespace(line.replace(/^[•\-o]\s*/, ""));
    if (/^(resources|additional information \/ resources|additional information)$/i.test(trimmed)) {
      capturing = true;
      continue;
    }
    if (capturing && /^(future considerations|guidance|requirements|background|purpose|agency partners can|the irs office)/i.test(trimmed)) {
      break;
    }
    if (capturing && trimmed) resources.push(trimmed);
  }

  return resources.slice(0, 20);
}

export function inferInterimGuidanceInput(
  input: InterimGuidanceInferenceInput
): KnowledgeImportInput {
  const subject = matchLine(input.text, "Subject");
  const dateText = matchLine(input.text, "Date");
  const guidanceDate = input.guidanceDate || toIsoDate(dateText);
  const effectiveDate = input.effectiveDate || extractEffectiveDate(input.text) || guidanceDate;
  const title = input.title || subject || stripExtension(input.fileName);
  const alertType = firstLine(input.text);
  const impactedPub1075Sections = uniqueMatches(
    input.text,
    /\bSection\s+\d+(?:\.[A-Z0-9]+)*(?:\.\d+)*(?:\s*,\s*[A-Z]{2}-\d+(?:\([^)]+\))?)?/gi
  );
  const impactedControls = uniqueMatches(
    input.text,
    /\b(?:AC|AT|AU|CA|CM|CP|IA|IR|MA|MP|PE|PL|PM|PS|PT|RA|SA|SC|SI|SR)-\d+(?:\([^)]+\))?\b/gi
  ).map((control) => control.toUpperCase());
  const contactEmails = uniqueMatches(
    input.text,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
  );
  const supersedesOrAmends =
    /\b(supersedes|amends|revised|will be revised|disregard mentions|removed|disallowing|withdrawn)\b/i.test(
      input.text
    );

  const metadata = {
    relationshipToPub1075: supersedesOrAmends ? "supersedes_or_amends" : "supplements",
    supersedesOrAmendsPub1075: supersedesOrAmends,
    guidanceDate,
    effectiveDate,
    authority: input.authority || "IRS Office of Safeguards interim guidance",
    alertType,
    subject,
    issuedBy: /Office of Safeguards/i.test(input.text)
      ? "IRS Office of Safeguards"
      : undefined,
    impactedPub1075Sections,
    impactedControls,
    contactEmails,
    resources: extractResources(input.text),
    inferredFromFile: true,
    ...input.metadata,
  };

  return {
    title,
    content: input.text,
    sourceType: INTERIM_GUIDANCE_SOURCE_TYPE,
    sourceName: input.sourceName || input.fileName,
    version:
      input.version ||
      (guidanceDate ? `Interim Guidance ${guidanceDate}` : "Interim Guidance"),
    description:
      input.description ||
      `${title}${guidanceDate ? ` issued ${guidanceDate}` : ""}.`,
    importedById: input.importedById,
    metadata,
  };
}
