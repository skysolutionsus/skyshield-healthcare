import * as fs from "fs";
import * as path from "path";
import { detectPub1075Version } from "@/lib/knowledge/ingest";

type NistCatalogControl = {
    id: string;
    title: string;
    statement: string;
    guidance: string;
};

type NistCatalogSnapshot = {
    title: string;
    version: string;
    lastModified: string;
    sourceUrl: string;
    publicationUrl: string;
    controls: NistCatalogControl[];
};

export type ComplianceEvidence = {
    version: string;
    sourcePath: string;
    excerpts: string;
    pub1075: {
        version: string;
        sourcePath: string;
        controlIds: string[];
        excerpts: string;
    };
    nist: {
        version: string;
        sourcePath: string;
        sourceUrl: string;
        controlIds: string[];
        excerpts: string;
    };
    requestedControlIds: string[];
    uncoveredControlIds: string[];
};

const PUB1075_SOURCE_PATH = "data/pub1075/p1075-full-text.md";
const NIST_SOURCE_PATH = "data/nist/sp800-53-rev5-controls.json";
const CONTROL_HEADER = /^([A-Z]{2,3}-\d+)(?:\s|:)/;

let nistSnapshotCache: NistCatalogSnapshot | null | undefined;

export function normalizeNistControlId(value: string | null | undefined): string | null {
    const normalized = String(value || "")
        .toUpperCase()
        .replace(/[–—]/g, "-")
        .replace(/\s+/g, "")
        .replace(/^(?:NIST|SP800-53)[:\-]?/i, "");
    const match = normalized.match(/^([A-Z]{2,3})-0*(\d+)(?:\(?0*(\d+)\)?)?/);
    if (!match) return null;

    const enhancement = match[3]
        ? `(${Number.parseInt(match[3], 10)})`
        : "";
    return `${match[1]}-${Number.parseInt(match[2], 10)}${enhancement}`;
}
function baseControlId(value: string): string {
    return value.match(/^([A-Z]{2,3}-\d+)/)?.[1] || value;
}

function uniqueControlIds(values: Array<string | null | undefined>): string[] {
    return [...new Set(values
        .map(normalizeNistControlId)
        .filter((value): value is string => Boolean(value)))];
}

function compactExcerpt(value: string, maxChars: number): string {
    const normalized = value
        .replace(/\n{4,}/g, "\n\n")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars).trimEnd()}\n[Excerpt truncated]`;
}

function candidatePub1075Sections(fullText: string): Map<string, string> {
    const lines = fullText.split("\n");
    const candidates = new Map<string, string[]>();

    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(CONTROL_HEADER);
        if (!match) continue;

        const controlId = baseControlId(match[1]);
        const block = [lines[index]];
        for (let cursor = index + 1; cursor < lines.length; cursor++) {
            if (CONTROL_HEADER.test(lines[cursor])) break;
            block.push(lines[cursor]);
        }
        const text = block.join("\n").trim();
        if (!candidates.has(controlId)) candidates.set(controlId, []);
        candidates.get(controlId)?.push(text);
    }

    const selected = new Map<string, string>();
    for (const [controlId, sections] of candidates) {
        const best = sections
            .filter((section) => section.length >= 80)
            .sort((left, right) => {
                const substance = (value: string) =>
                    value.length +
                    (/Control Enhancements|Supplemental Guidance|IRS-Defined/i.test(value) ? 4000 : 0) -
                    (/_{8,}|\.\s*\.\s*\./.test(value) ? 3000 : 0);
                return substance(right) - substance(left);
            })[0];
        if (best) selected.set(controlId, best);
    }

    return selected;
}

function loadNistSnapshot(): NistCatalogSnapshot | null {
    if (nistSnapshotCache !== undefined) return nistSnapshotCache;

    const filePath = path.join(process.cwd(), NIST_SOURCE_PATH);
    if (!fs.existsSync(filePath)) {
        nistSnapshotCache = null;
        return null;
    }

    try {
        nistSnapshotCache = JSON.parse(fs.readFileSync(filePath, "utf8")) as NistCatalogSnapshot;
    } catch (error) {
        console.warn("Could not read the local NIST SP 800-53 catalog snapshot:", error);
        nistSnapshotCache = null;
    }
    return nistSnapshotCache;
}

export function extractComplianceEvidence(
    nistIds: Array<string | null | undefined>,
    options: {
        maxPubCharsPerControl?: number;
        maxNistCharsPerControl?: number;
        maxTotalChars?: number;
    } = {}
): ComplianceEvidence {
    const requestedControlIds = uniqueControlIds(nistIds);
    const requestedByBase = new Map<string, string[]>();
    for (const controlId of requestedControlIds) {
        const base = baseControlId(controlId);
        requestedByBase.set(base, [...(requestedByBase.get(base) || []), controlId]);
    }

    const maxPubCharsPerControl = options.maxPubCharsPerControl ?? 3600;
    const maxNistCharsPerControl = options.maxNistCharsPerControl ?? 2200;
    const maxTotalChars = options.maxTotalChars ?? 28000;
    const pubFilePath = path.join(process.cwd(), PUB1075_SOURCE_PATH);
    const pubText = fs.existsSync(pubFilePath) ? fs.readFileSync(pubFilePath, "utf8") : "";
    const pubVersion = pubText ? detectPub1075Version(pubText) : "Unknown";
    const pubSections = pubText ? candidatePub1075Sections(pubText) : new Map<string, string>();
    const pubControlIds: string[] = [];
    const pubBlocks: string[] = [];
    let totalChars = 0;

    for (const [base, requested] of requestedByBase) {
        const section = pubSections.get(base);
        if (!section) continue;

        const excerpt = compactExcerpt(section, maxPubCharsPerControl);
        if (totalChars + excerpt.length > maxTotalChars) continue;
        pubControlIds.push(...requested);
        pubBlocks.push(`Requested controls: ${requested.join(", ")}\n${excerpt}`);
        totalChars += excerpt.length;
    }

    const pubCovered = new Set(pubControlIds);
    const nistRequested = requestedControlIds.filter((controlId) => !pubCovered.has(controlId));
    const nistSnapshot = loadNistSnapshot();
    const nistById = new Map((nistSnapshot?.controls || []).map((control) => [control.id, control]));
    const nistControlIds: string[] = [];
    const nistBlocks: string[] = [];

    for (const requestedId of nistRequested) {
        const control = nistById.get(requestedId) || nistById.get(baseControlId(requestedId));
        if (!control) continue;

        const excerpt = compactExcerpt([
            `${control.id} ${control.title}`,
            `Control: ${control.statement}`,
            control.guidance ? `Discussion: ${control.guidance}` : "",
        ].filter(Boolean).join("\n"), maxNistCharsPerControl);
        if (totalChars + excerpt.length > maxTotalChars) continue;
        nistControlIds.push(requestedId);
        nistBlocks.push(excerpt);
        totalChars += excerpt.length;
    }

    const nistCovered = new Set(nistControlIds);
    const uncoveredControlIds = requestedControlIds.filter(
        (controlId) => !pubCovered.has(controlId) && !nistCovered.has(controlId)
    );
    const pubExcerpts = pubBlocks.join("\n\n---\n\n");
    const nistExcerpts = nistBlocks.join("\n\n---\n\n");
    const combined = [
        pubExcerpts
            ? `IRS PUBLICATION 1075 — AUTHORITATIVE REQUIREMENTS (${pubVersion})\n${pubExcerpts}`
            : "",
        nistExcerpts
            ? `NIST SP 800-53 — FALLBACK ONLY (${nistSnapshot?.version || "Unknown"})\nUse these controls only where no Pub 1075 section was found.\n${nistExcerpts}`
            : "",
    ].filter(Boolean).join("\n\n=======\n\n");

    return {
        // Backward-compatible top-level fields used by existing updater prompts.
        version: pubVersion,
        sourcePath: PUB1075_SOURCE_PATH,
        excerpts: combined,
        pub1075: {
            version: pubVersion,
            sourcePath: PUB1075_SOURCE_PATH,
            controlIds: pubControlIds,
            excerpts: pubExcerpts,
        },
        nist: {
            version: nistSnapshot?.version || "Unknown",
            sourcePath: NIST_SOURCE_PATH,
            sourceUrl: nistSnapshot?.publicationUrl || nistSnapshot?.sourceUrl || "",
            controlIds: nistControlIds,
            excerpts: nistExcerpts,
        },
        requestedControlIds,
        uncoveredControlIds,
    };
}
