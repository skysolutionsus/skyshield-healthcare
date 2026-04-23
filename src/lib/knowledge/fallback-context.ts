import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

interface FallbackFile {
  label: string;
  sourceType: "pub1075" | "interim_guidance";
  pages: Array<{ label: string; content: string }>;
}

let cache: FallbackFile[] | null = null;

function splitPages(text: string, baseLabel: string): Array<{ label: string; content: string }> {
  const parts = text.split(/\n--- PAGE (\d+) ---\n/g);
  const pages: Array<{ label: string; content: string }> = [];

  if (parts[0]?.trim()) {
    pages.push({ label: `${baseLabel} — front matter`, content: parts[0].trim() });
  }

  if (parts.length === 1) {
    return [{ label: baseLabel, content: text.trim() }];
  }

  for (let i = 1; i < parts.length; i += 2) {
    pages.push({
      label: `${baseLabel} — page ${parts[i]}`,
      content: parts[i + 1]?.trim() || "",
    });
  }

  return pages.filter((p) => p.content.length > 0);
}

function loadFallbackCorpus(): FallbackFile[] {
  if (cache) return cache;

  const files: FallbackFile[] = [];
  const cwd = process.cwd();

  const pub1075Candidates = [
    join(cwd, "data", "pub1075", "p1075-full-text.md"),
    join("/app", "data", "pub1075", "p1075-full-text.md"),
  ];

  for (const filePath of pub1075Candidates) {
    if (!existsSync(filePath)) continue;
    const text = readFileSync(filePath, "utf-8");
    if (text.trim().length < 1_000) continue;
    files.push({
      label: "IRS Publication 1075",
      sourceType: "pub1075",
      pages: splitPages(text, "Pub 1075"),
    });
    break;
  }

  const interimDirs = [join(cwd, "public"), join("/app", "public")];
  for (const dir of interimDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir).filter((name) =>
        /interim guidance/i.test(name) && name.endsWith(".txt")
      );
      for (const name of entries) {
        const filePath = join(dir, name);
        const text = readFileSync(filePath, "utf-8").trim();
        if (text.length < 200) continue;
        const label = name.replace(/\.txt$/i, "");
        files.push({
          label,
          sourceType: "interim_guidance",
          pages: splitPages(text, label),
        });
      }
      if (entries.length > 0) break;
    } catch {
      // skip directory on read error
    }
  }

  cache = files;
  return files;
}

const STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "can", "does", "for", "from", "how",
  "into", "irs", "must", "pub", "publication", "should", "that", "the", "their",
  "this", "what", "when", "where", "which", "with",
]);

function getSearchTerms(message: string): string[] {
  const normalized = message.toLowerCase();
  const terms = new Set(
    (normalized.match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter(
      (term) => !STOP_WORDS.has(term)
    )
  );

  if (/\b(encrypt|encrypted|encryption|cryptographic|fips|rest|cloud|key|keys)\b/i.test(message)) {
    ["SC-28", "Protection of Information at Rest", "FIPS 140", "cryptographic"].forEach((t) =>
      terms.add(t.toLowerCase())
    );
  }
  if (/\b(media|removable|backup|storage|transport|laptop|mobile|device)\b/i.test(message)) {
    ["MP-4", "MP-5", "AC-19"].forEach((t) => terms.add(t.toLowerCase()));
  }
  if (/\b(access|account|authentication|mfa|multi-factor|password|remote)\b/i.test(message)) {
    ["AC-2", "AC-17", "IA-2", "IA-5"].forEach((t) => terms.add(t.toLowerCase()));
  }
  if (/\b(incident|breach|disclosure|report)\b/i.test(message)) {
    ["IR-4", "IR-6", "IR-8"].forEach((t) => terms.add(t.toLowerCase()));
  }

  return [...terms];
}

export interface FallbackContextOptions {
  message: string;
  maxChars?: number;
}

export function buildFallbackContext({ message, maxChars = 90_000 }: FallbackContextOptions): {
  context: string;
  warning: string;
  includedInterim: boolean;
} {
  const files = loadFallbackCorpus();
  if (files.length === 0) {
    return {
      context: "No fallback corpus available (Pub 1075 and interim guidance files not found on disk).",
      warning:
        "DEGRADED MODE: Knowledge retrieval from the database failed and no local fallback corpus was found on disk. Answer with extreme caution and explicitly tell the user that live retrieval and local fallback both failed.",
      includedInterim: false,
    };
  }

  const terms = getSearchTerms(message);

  const scoredPages = files.flatMap((file) =>
    file.pages.map((page) => {
      const lower = page.content.toLowerCase();
      const baseScore = terms.reduce((total, term) => {
        if (!term) return total;
        const matches = lower.split(term).length - 1;
        return total + matches * Math.max(1, Math.min(5, Math.ceil(term.length / 6)));
      }, 0);
      // Prioritize interim guidance over baseline when both match.
      const sourceBoost = file.sourceType === "interim_guidance" ? 20 : 0;
      return { file, page, score: baseScore + sourceBoost };
    })
  );

  const relevant = scoredPages.filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
  const interimAlwaysInclude = scoredPages.filter(
    (p) => p.file.sourceType === "interim_guidance" && p.score === 0
  );

  const selection = relevant.length > 0 ? relevant : scoredPages.slice(0, 8);
  const withInterimFloor = [
    ...selection,
    ...interimAlwaysInclude.filter(
      (p) => !selection.find((s) => s.file === p.file && s.page.label === p.page.label)
    ),
  ];

  let includedInterim = false;
  let context = "DEGRADED MODE: Knowledge retrieval from the database failed. Answering from local Pub 1075 and interim guidance files on disk. Results are a keyword-scored subset and may be incomplete.\n\n";

  for (const entry of withInterimFloor) {
    const excerpt = `\n--- ${entry.file.sourceType === "interim_guidance" ? "INTERIM GUIDANCE" : "PUB 1075"} EXCERPT: ${entry.page.label} ---\n${entry.page.content}\n`;
    if (context.length + excerpt.length > maxChars) break;
    context += excerpt;
    if (entry.file.sourceType === "interim_guidance") includedInterim = true;
  }

  return {
    context,
    warning:
      "DEGRADED MODE: Knowledge retrieval from the database failed. Responses are based on local file fallback and may not reflect the most recent interim guidance. Advise the user that live retrieval was unavailable for this query.",
    includedInterim,
  };
}

export function clearFallbackCache(): void {
  cache = null;
}
