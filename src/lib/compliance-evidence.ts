import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import { detectPub1075Version } from "@/lib/knowledge/ingest";
import { verifyComplianceSourceIntegrity } from "@/lib/compliance-source-integrity";

type NistCatalogControl = {
    id: string;
    title: string;
    statement: string;
    guidance: string;
    assessmentObjectives?: NistAssessmentObjective[];
    assessmentMethods?: NistAssessmentMethod[];
};

type NistAssessmentObjective = {
    id: string;
    label: string;
    text: string;
    children: NistAssessmentObjective[];
};

type NistAssessmentMethod = {
    id: string;
    label: string;
    method: "EXAMINE" | "INTERVIEW" | "TEST" | string;
    assessmentObjects: Array<{
        id: string;
        title: string;
        text: string;
    }>;
};

type NistCatalogSnapshot = {
    title: string;
    version: string;
    lastModified: string;
    sourceUrl: string;
    publicationUrl: string;
    sourceCommit?: string;
    sourceSha256?: string;
    snapshotSha256?: string;
    controls: NistCatalogControl[];
};

export type ComplianceEvidence = {
    version: string;
    sourcePath: string;
    excerpts: string;
    pub1075: {
        version: string;
        sourcePath: string;
        sourceSha256: string;
        controlIds: string[];
        excerptedControlIds: string[];
        excerpts: string;
    };
    nist: {
        version: string;
        sourcePath: string;
        sourceUrl: string;
        publicationUrl: string;
        sourceCommit: string;
        sourceSha256: string;
        snapshotSha256: string;
        lastModified: string;
        controlIds: string[];
        excerptedControlIds: string[];
        excerpts: string;
        assessmentControlIds: string[];
        assessmentExcerpts: string;
    };
    requestedControlIds: string[];
    uncoveredControlIds: string[];
};

const PUB1075_SOURCE_PATH = "data/pub1075/p1075-full-text.md";
const NIST_SOURCE_PATH = "data/nist/sp800-53-rev5-controls.json";
const CONTROL_HEADER = /^([A-Z]{2,3}-\d+)(?:\s|:)/;
const CONTROL_ENHANCEMENT = /\(CE-0*(\d+)\)/gi;

type Pub1075Section = {
    text: string;
    coveredControlIds: Set<string>;
};

let nistSnapshotCache: NistCatalogSnapshot | null | undefined;

export function normalizeNistControlId(value: string | null | undefined): string | null {
    const normalized = String(value || "")
        .toUpperCase()
        .replace(/[–—]/g, "-")
        .replace(/\s+/g, "")
        .replace(/^(?:NIST|SP800-53)[:\-]?/i, "");
    const match = normalized.match(/^([A-Z]{2,3})-0*(\d+)(?:\(0*(\d+)\))?$/);
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

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function objectiveLines(objectives: NistAssessmentObjective[]): string[] {
    const lines: string[] = [];
    const visit = (objective: NistAssessmentObjective) => {
        if (objective.text?.trim()) {
            lines.push(`${objective.label || objective.id}: ${objective.text.trim()}`);
        }
        for (const child of objective.children || []) visit(child);
    };
    for (const objective of objectives) visit(objective);
    return lines;
}

function assessmentExcerpt(control: NistCatalogControl, maxChars: number): string {
    const objectives = objectiveLines(control.assessmentObjectives || []);
    const methodSources = control.assessmentMethods || [];
    const methodBudget = Math.min(900, Math.max(300, Math.floor(maxChars * 0.4)));
    const perMethodBudget = Math.max(100, Math.floor(methodBudget / Math.max(methodSources.length, 1)));
    const methods = methodSources.map((method) => {
        const objects = method.assessmentObjects
            .map((object) => object.text?.trim())
            .filter(Boolean)
            .join("; ");
        const detail = objects || method.label || method.id;
        const available = Math.max(20, perMethodBudget - method.method.length - 2);
        const summarized = detail.length <= available
            ? detail
            : `${detail.slice(0, Math.max(0, available - 1)).trimEnd()}…`;
        return `${method.method}: ${summarized}`;
    });
    if (objectives.length === 0 && methods.length === 0) return "";

    const header = `NIST SP 800-53A ${control.id} ${control.title}`;
    const methodsBlock = methods.length > 0
        ? `Assessment methods and objects:\n${methods.join("\n")}`
        : "";
    const objectiveBudget = Math.max(
        100,
        maxChars - header.length - methodsBlock.length - 40
    );
    const objectivesBlock = objectives.length > 0
        ? `Assessment objectives:\n${compactExcerpt(objectives.join("\n"), objectiveBudget)}`
        : "";

    // Methods are placed first and independently bounded so a long list of
    // objectives cannot erase EXAMINE/INTERVIEW/TEST evidence from the prompt.
    return compactExcerpt([
        header,
        methodsBlock,
        objectivesBlock,
    ].filter(Boolean).join("\n"), maxChars);
}

function pub1075Coverage(controlId: string, section: string): Set<string> {
    const covered = new Set<string>([controlId]);
    for (const match of section.matchAll(CONTROL_ENHANCEMENT)) {
        covered.add(`${controlId}(${Number.parseInt(match[1], 10)})`);
    }
    return covered;
}

function candidatePub1075Sections(fullText: string): Map<string, Pub1075Section> {
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

    const selected = new Map<string, Pub1075Section>();
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
        if (best) {
            selected.set(controlId, {
                text: best,
                coveredControlIds: pub1075Coverage(controlId, best),
            });
        }
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
        const rawSnapshot = fs.readFileSync(filePath, "utf8");
        nistSnapshotCache = {
            ...(JSON.parse(rawSnapshot) as NistCatalogSnapshot),
            snapshotSha256: sha256(rawSnapshot),
        };
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
    verifyComplianceSourceIntegrity();
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
    const pubSourceSha256 = pubText ? sha256(pubText) : "";
    const pubSections = pubText
        ? candidatePub1075Sections(pubText)
        : new Map<string, Pub1075Section>();
    const pubControlIds = requestedControlIds.filter((requestedId) => {
        const section = pubSections.get(baseControlId(requestedId));
        return section?.coveredControlIds.has(requestedId) || false;
    });
    const pubCovered = new Set(pubControlIds);
    const pubExcerptedControlIds: string[] = [];
    const pubBlocks: string[] = [];
    let totalChars = 0;

    for (const [base, requested] of requestedByBase) {
        const section = pubSections.get(base);
        if (!section) continue;

        const coveredRequested = requested.filter((controlId) => pubCovered.has(controlId));
        if (coveredRequested.length === 0) continue;

        const excerpt = compactExcerpt(section.text, maxPubCharsPerControl);
        if (totalChars + excerpt.length > maxTotalChars) continue;
        pubExcerptedControlIds.push(...coveredRequested);
        pubBlocks.push(`Requested controls: ${coveredRequested.join(", ")}\n${excerpt}`);
        totalChars += excerpt.length;
    }

    const nistRequested = requestedControlIds.filter((controlId) => !pubCovered.has(controlId));
    const nistSnapshot = loadNistSnapshot();
    const nistById = new Map((nistSnapshot?.controls || []).map((control) => [control.id, control]));
    // An enhancement is authoritative only when that exact enhancement exists in
    // the catalog. Falling back to its base control would silently invent coverage.
    const nistControlIds = nistRequested.filter((requestedId) => nistById.has(requestedId));
    const nistExcerptedControlIds: string[] = [];
    const nistBlocks: string[] = [];

    for (const requestedId of nistControlIds) {
        const control = nistById.get(requestedId);
        if (!control) continue;

        const excerpt = compactExcerpt([
            `${control.id} ${control.title}`,
            `Control: ${control.statement}`,
            control.guidance ? `Discussion: ${control.guidance}` : "",
        ].filter(Boolean).join("\n"), maxNistCharsPerControl);
        if (totalChars + excerpt.length > maxTotalChars) continue;
        nistExcerptedControlIds.push(requestedId);
        nistBlocks.push(excerpt);
        totalChars += excerpt.length;
    }

    const nistAssessmentControlIds: string[] = [];
    const nistAssessmentBlocks: string[] = [];
    for (const requestedId of requestedControlIds) {
        const control = nistById.get(requestedId);
        if (!control) continue;
        const excerpt = assessmentExcerpt(control, maxNistCharsPerControl);
        if (!excerpt || totalChars + excerpt.length > maxTotalChars) continue;
        nistAssessmentControlIds.push(requestedId);
        nistAssessmentBlocks.push(excerpt);
        totalChars += excerpt.length;
    }

    const nistCovered = new Set(nistControlIds);
    const uncoveredControlIds = requestedControlIds.filter(
        (controlId) => !pubCovered.has(controlId) && !nistCovered.has(controlId)
    );
    const pubExcerpts = pubBlocks.join("\n\n---\n\n");
    const nistExcerpts = nistBlocks.join("\n\n---\n\n");
    const nistAssessmentExcerpts = nistAssessmentBlocks.join("\n\n---\n\n");
    const combined = [
        pubExcerpts
            ? `IRS PUBLICATION 1075 — AUTHORITATIVE REQUIREMENTS (${pubVersion})\n${pubExcerpts}`
            : "",
        nistExcerpts
            ? `NIST SP 800-53 — FALLBACK ONLY (${nistSnapshot?.version || "Unknown"})\nUse these controls only where no Pub 1075 section was found.\n${nistExcerpts}`
            : "",
        nistAssessmentExcerpts
            ? `NIST SP 800-53A — SUPPLEMENTAL ASSESSMENT OBJECTIVES AND METHODS (${nistSnapshot?.version || "Unknown"})\nUse these only to ground test procedures and expected evidence. They do not replace or override Pub 1075 requirements.\n${nistAssessmentExcerpts}`
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
            sourceSha256: pubSourceSha256,
            controlIds: pubControlIds,
            excerptedControlIds: pubExcerptedControlIds,
            excerpts: pubExcerpts,
        },
        nist: {
            version: nistSnapshot?.version || "Unknown",
            sourcePath: NIST_SOURCE_PATH,
            sourceUrl: nistSnapshot?.sourceUrl || "",
            publicationUrl: nistSnapshot?.publicationUrl || "",
            sourceCommit: nistSnapshot?.sourceCommit || "",
            sourceSha256: nistSnapshot?.sourceSha256 || "",
            snapshotSha256: nistSnapshot?.snapshotSha256 || "",
            lastModified: nistSnapshot?.lastModified || "",
            controlIds: nistControlIds,
            excerptedControlIds: nistExcerptedControlIds,
            excerpts: nistExcerpts,
            assessmentControlIds: nistAssessmentControlIds,
            assessmentExcerpts: nistAssessmentExcerpts,
        },
        requestedControlIds,
        uncoveredControlIds,
    };
}
