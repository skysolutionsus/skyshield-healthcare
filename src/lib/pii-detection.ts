// ---------------------------------------------------------------------------
// PII / FTI Detection Library for IRS SkyShield
//
// Detects: SSNs, EINs, tax form references with financial data,
// credit card numbers, bank account numbers, and financial data patterns.
//
// Design goal: HIGH precision.  We deliberately accept some false negatives
// to avoid blocking legitimate compliance discussions that reference section
// numbers, dates, phone numbers, or dollar amounts in isolation.
// ---------------------------------------------------------------------------

export type PiiType =
  | "SSN"
  | "EIN"
  | "TAX_FORM"
  | "FINANCIAL_DATA"
  | "CREDIT_CARD"
  | "BANK_ACCOUNT";

export interface PiiMatch {
  type: PiiType;
  pattern: string; // The matched text, redacted for safety
  position: number;
  confidence: "HIGH" | "MEDIUM";
}

export interface PiiDetectionResult {
  hasPII: boolean;
  matches: PiiMatch[];
  sanitizedText: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Redact a matched string, keeping only the first and last characters. */
function redact(value: string): string {
  if (value.length <= 4) return "***";
  return value[0] + "*".repeat(value.length - 2) + value[value.length - 1];
}

// ---------------------------------------------------------------------------
// SSN Detection
// ---------------------------------------------------------------------------
// Format: XXX-XX-XXXX
// Rules from SSA:
//   - Area (first 3): 001-899, excluding 666
//   - Group (middle 2): 01-99
//   - Serial (last 4): 0001-9999

const SSN_DASHED_RE =
  /(?<!\d[-–])(?<!\d)\b((?!000)(?!666)(?:[0-8]\d{2}))[- ]((?!00)\d{2})[- ]((?!0000)\d{4})\b(?![-–]\d)/g;

// Nine consecutive digits that look like an SSN (no separators).
// We require word boundaries AND context that it is not part of a longer
// number, phone number, or section reference.
const SSN_BARE_RE =
  /(?<!\d)(?<![.\-/])((?!000)(?!666)[0-8]\d{2})((?!00)\d{2})((?!0000)\d{4})(?!\d)(?![.\-/]\d)/g;

function detectSSNs(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];

  // Dashed / spaced SSNs — high confidence
  for (const m of text.matchAll(SSN_DASHED_RE)) {
    matches.push({
      type: "SSN",
      pattern: redact(m[0]),
      position: m.index!,
      confidence: "HIGH",
    });
  }

  // Bare 9-digit SSNs — medium confidence
  // Exclude if surrounded by context suggesting it is NOT an SSN:
  //   - Part of a phone number (preceded/followed by parentheses, "phone", "tel", "fax")
  //   - Part of a section reference or version number (contains dots nearby)
  for (const m of text.matchAll(SSN_BARE_RE)) {
    const start = Math.max(0, m.index! - 20);
    const end = Math.min(text.length, m.index! + m[0].length + 20);
    const context = text.slice(start, end).toLowerCase();

    // Skip if context looks like phone, fax, section reference, zip code, date
    if (/(?:phone|tel|fax|call|dial|ext\.?|section|sec\.|§|\.[\d]|ver)/.test(context)) {
      continue;
    }
    // Skip if the 9 digits appear inside a longer numeric string
    if (/\d{10,}/.test(context)) {
      continue;
    }

    matches.push({
      type: "SSN",
      pattern: redact(m[0]),
      position: m.index!,
      confidence: "MEDIUM",
    });
  }

  return matches;
}

// ---------------------------------------------------------------------------
// EIN Detection
// ---------------------------------------------------------------------------
// Format: XX-XXXXXXX
// First two digits are valid IRS campus prefixes.

const VALID_EIN_PREFIXES = new Set([
  "10", "12", "60", "67", "50", "53", "01", "02", "03", "04", "05", "06",
  "11", "13", "14", "16", "21", "22", "23", "25", "34", "51", "52", "54",
  "55", "56", "57", "58", "59", "65", "30", "32", "35", "36", "37", "38",
  "61", "15", "24", "40", "44", "94", "95", "80", "90", "33", "39", "41",
  "42", "43", "46", "48", "62", "63", "64", "66", "68", "71", "72", "73",
  "74", "75", "76", "77", "81", "82", "83", "84", "85", "86", "87", "88",
  "91", "92", "93", "98", "99", "20", "26", "27", "45", "46", "47", "81",
  "82", "83",
]);

const EIN_RE = /(?<!\d)\b(\d{2})-(\d{7})\b(?![-]\d)/g;

function detectEINs(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];

  for (const m of text.matchAll(EIN_RE)) {
    const prefix = m[1];
    if (!VALID_EIN_PREFIXES.has(prefix)) continue;

    // Exclude patterns that look like section references (e.g., "Section 12-3456789")
    const start = Math.max(0, m.index! - 30);
    const before = text.slice(start, m.index!).toLowerCase();
    if (/(?:section|sec\.?|§|chapter|part|paragraph|pub\.?|irs)\s*$/.test(before)) {
      continue;
    }

    matches.push({
      type: "EIN",
      pattern: redact(m[0]),
      position: m.index!,
      confidence: "HIGH",
    });
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Tax Form Detection
// ---------------------------------------------------------------------------
// We look for references to specific IRS forms combined with dollar amounts
// or specific financial terms in close proximity.  A bare mention of
// "Form 1040" in a compliance discussion is NOT flagged — it must appear
// alongside actual financial figures.

const TAX_FORM_NAMES = [
  "form 1040",
  "form 1040-sr",
  "form 1040-nr",
  "form 1040-x",
  "form 1099",
  "form 1099-misc",
  "form 1099-nec",
  "form 1099-int",
  "form 1099-div",
  "form 1099-r",
  "form 1099-g",
  "form 1099-b",
  "form 1099-k",
  "form 1098",
  "form w-2",
  "form w-4",
  "form w-9",
  "schedule a",
  "schedule b",
  "schedule c",
  "schedule d",
  "schedule e",
  "schedule f",
  "schedule k-1",
  "schedule se",
  "form 941",
  "form 940",
  "form 943",
  "form 944",
  "form 8949",
  "form 4868",
  "form 2553",
  "w-2",
  "w-4",
  "w-9",
  "1099-misc",
  "1099-nec",
];

const DOLLAR_RE = /\$[\d,]+(?:\.\d{2})?/;

const FINANCIAL_KEYWORDS = [
  "adjusted gross income",
  "taxable income",
  "total income",
  "gross income",
  "wages",
  "salary",
  "compensation",
  "withholding",
  "refund",
  "tax owed",
  "tax due",
  "tax liability",
  "earned income",
  "net income",
  "agi",
  "filing status",
  "exemptions",
  "deductions",
  "tax return",
  "tax filing",
];

function detectTaxFormData(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];
  const lowerText = text.toLowerCase();

  for (const formName of TAX_FORM_NAMES) {
    let searchStart = 0;
    while (true) {
      const idx = lowerText.indexOf(formName, searchStart);
      if (idx === -1) break;
      searchStart = idx + formName.length;

      // Look within a 300-character window around the form reference for
      // dollar amounts — this suggests actual tax data, not a policy discussion.
      const windowStart = Math.max(0, idx - 150);
      const windowEnd = Math.min(text.length, idx + formName.length + 150);
      const window = text.slice(windowStart, windowEnd);

      if (DOLLAR_RE.test(window)) {
        matches.push({
          type: "TAX_FORM",
          pattern: `[${formName.toUpperCase()} with financial data]`,
          position: idx,
          confidence: "HIGH",
        });
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Financial Data Detection
// ---------------------------------------------------------------------------
// Detect financial keywords appearing alongside specific dollar amounts.
// This catches things like "adjusted gross income of $52,340" without
// flagging generic dollar references like "costs $50".

function detectFinancialData(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];
  const lowerText = text.toLowerCase();

  for (const keyword of FINANCIAL_KEYWORDS) {
    let searchStart = 0;
    while (true) {
      const idx = lowerText.indexOf(keyword, searchStart);
      if (idx === -1) break;
      searchStart = idx + keyword.length;

      const windowStart = Math.max(0, idx - 100);
      const windowEnd = Math.min(text.length, idx + keyword.length + 100);
      const window = text.slice(windowStart, windowEnd);

      // Must have a specific dollar amount (not just "$" alone)
      const dollarMatch = window.match(/\$[\d,]+(?:\.\d{2})?/);
      if (dollarMatch && dollarMatch[0].replace(/[$,]/g, "").length >= 2) {
        matches.push({
          type: "FINANCIAL_DATA",
          pattern: `[${keyword.toUpperCase()} with dollar amount]`,
          position: idx,
          confidence: "MEDIUM",
        });
        // Only flag once per keyword occurrence
        break;
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Credit Card Detection
// ---------------------------------------------------------------------------
// Common patterns: 16-digit (Visa, MC, Discover) or 15-digit (Amex)
// Must not be part of a longer number sequence.

const CC_PATTERNS = [
  // Visa: starts with 4, 16 digits (with optional separators)
  /(?<!\d)\b4\d{3}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b(?!\d)/g,
  // MasterCard: starts with 51-55 or 2221-2720, 16 digits
  /(?<!\d)\b5[1-5]\d{2}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b(?!\d)/g,
  // Amex: starts with 34 or 37, 15 digits
  /(?<!\d)\b3[47]\d{2}[- ]?\d{6}[- ]?\d{5}\b(?!\d)/g,
  // Discover: starts with 6011 or 65, 16 digits
  /(?<!\d)\b(?:6011|65\d{2})[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b(?!\d)/g,
];

function detectCreditCards(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];

  for (const pattern of CC_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      // Skip if it looks like a section reference or other non-card context
      const start = Math.max(0, m.index! - 20);
      const context = text.slice(start, m.index!).toLowerCase();
      if (/(?:section|sec\.?|§|version|ver|v\.)/.test(context)) continue;

      matches.push({
        type: "CREDIT_CARD",
        pattern: redact(m[0]),
        position: m.index!,
        confidence: "HIGH",
      });
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Bank Account Number Detection
// ---------------------------------------------------------------------------
// Look for routing numbers (9 digits starting with 0-3) paired with
// account number keywords, or explicit "account number" / "routing number"
// labels followed by digit sequences.

const BANK_ACCOUNT_RE =
  /(?:(?:account|acct|routing|aba|ach)\s*(?:number|num|no|#)?[:.\s]*)\b(\d{4,17})\b/gi;

function detectBankAccounts(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];

  for (const m of text.matchAll(BANK_ACCOUNT_RE)) {
    matches.push({
      type: "BANK_ACCOUNT",
      pattern: redact(m[1]),
      position: m.index!,
      confidence: "HIGH",
    });
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

function buildSanitizedText(text: string, matches: PiiMatch[]): string {
  if (matches.length === 0) return text;

  // We need the original matched text to do replacement.
  // Since `pattern` is redacted, we re-detect and replace in-place.
  let sanitized = text;

  // SSN dashed
  sanitized = sanitized.replace(SSN_DASHED_RE, "[REDACTED-SSN]");

  // SSN bare — only replace confirmed matches (recheck context)
  // We handle this by replacing from the end to preserve positions
  const bareMatches: Array<{ index: number; length: number }> = [];
  for (const m of text.matchAll(SSN_BARE_RE)) {
    const start = Math.max(0, m.index! - 20);
    const end = Math.min(text.length, m.index! + m[0].length + 20);
    const context = text.slice(start, end).toLowerCase();
    if (/(?:phone|tel|fax|call|dial|ext\.?|section|sec\.|§|\.[\d]|ver)/.test(context)) continue;
    if (/\d{10,}/.test(context)) continue;
    bareMatches.push({ index: m.index!, length: m[0].length });
  }
  // Replace from end to start to preserve indices
  for (let i = bareMatches.length - 1; i >= 0; i--) {
    const bm = bareMatches[i];
    sanitized =
      sanitized.slice(0, bm.index) +
      "[REDACTED-SSN]" +
      sanitized.slice(bm.index + bm.length);
  }

  // EIN
  sanitized = sanitized.replace(EIN_RE, (match, prefix, _suffix, offset) => {
    if (!VALID_EIN_PREFIXES.has(prefix)) return match;
    const start = Math.max(0, offset - 30);
    const before = text.slice(start, offset).toLowerCase();
    if (/(?:section|sec\.?|§|chapter|part|paragraph|pub\.?|irs)\s*$/.test(before)) return match;
    return "[REDACTED-EIN]";
  });

  // Credit cards
  for (const pattern of CC_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED-CREDIT_CARD]");
  }

  // Bank accounts
  sanitized = sanitized.replace(BANK_ACCOUNT_RE, (match, digits) => {
    return match.replace(digits, "[REDACTED-BANK_ACCOUNT]");
  });

  // Tax form + financial data contexts: we redact the dollar amounts near them
  // rather than the form name itself (the form name is public info).
  // We do a pass to redact dollar amounts that appear near flagged tax forms.
  const lowerSanitized = sanitized.toLowerCase();
  for (const formName of TAX_FORM_NAMES) {
    let searchStart = 0;
    while (true) {
      const idx = lowerSanitized.indexOf(formName, searchStart);
      if (idx === -1) break;
      searchStart = idx + formName.length;

      const windowStart = Math.max(0, idx - 150);
      const windowEnd = Math.min(sanitized.length, idx + formName.length + 150);
      const window = sanitized.slice(windowStart, windowEnd);

      if (DOLLAR_RE.test(window)) {
        // Redact dollar amounts in that window
        const newWindow = window.replace(
          /\$[\d,]+(?:\.\d{2})?/g,
          "[REDACTED-FINANCIAL_DATA]"
        );
        sanitized =
          sanitized.slice(0, windowStart) +
          newWindow +
          sanitized.slice(windowEnd);
      }
    }
  }

  // Financial keywords with dollar amounts
  const lowerSanitized2 = sanitized.toLowerCase();
  for (const keyword of FINANCIAL_KEYWORDS) {
    let searchStart = 0;
    while (true) {
      const idx = lowerSanitized2.indexOf(keyword, searchStart);
      if (idx === -1) break;
      searchStart = idx + keyword.length;

      const windowStart = Math.max(0, idx - 100);
      const windowEnd = Math.min(sanitized.length, idx + keyword.length + 100);
      const window = sanitized.slice(windowStart, windowEnd);

      if (DOLLAR_RE.test(window)) {
        const newWindow = window.replace(
          /\$[\d,]+(?:\.\d{2})?/g,
          "[REDACTED-FINANCIAL_DATA]"
        );
        sanitized =
          sanitized.slice(0, windowStart) +
          newWindow +
          sanitized.slice(windowEnd);
      }
    }
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function deduplicateMatches(matches: PiiMatch[]): PiiMatch[] {
  const seen = new Set<string>();
  return matches.filter((m) => {
    const key = `${m.type}:${m.position}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

export function detectPII(text: string): PiiDetectionResult {
  const allMatches: PiiMatch[] = [
    ...detectSSNs(text),
    ...detectEINs(text),
    ...detectTaxFormData(text),
    ...detectFinancialData(text),
    ...detectCreditCards(text),
    ...detectBankAccounts(text),
  ];

  const matches = deduplicateMatches(allMatches);
  const sanitizedText = buildSanitizedText(text, matches);

  return {
    hasPII: matches.length > 0,
    matches,
    sanitizedText,
  };
}
