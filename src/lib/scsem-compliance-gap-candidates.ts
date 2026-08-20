import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { verifyComplianceSourceIntegrity } from "@/lib/compliance-source-integrity";
import { normalizeNistControlId } from "@/lib/compliance-evidence";
import type { SCSEMControlEvidence } from "@/lib/scsem-update-engine";
import type { ParsedSCSEM } from "@/lib/xlsx-parser";

const PUB1075_SOURCE_PATH = "data/pub1075/p1075-full-text.md";
const NIST_SOURCE_PATH = "data/nist/sp800-53-rev5-controls.json";
const CONTROL_HEADER = /^([A-Z]{2,3}-\d+)(?:\s|:)/;

interface NistAssessmentMethod {
    method?: string;
    label?: string;
    assessmentObjects?: Array<{ text?: string }>;
}

interface NistControlReference {
    id: string;
    title: string;
    statement: string;
    guidance: string;
    assessmentMethods?: NistAssessmentMethod[];
}

export interface Pub1075ControlRequirement {
    controlId: string;
    title: string;
    pub1075Text: string;
    nistStatement: string;
    nistGuidance: string;
    assessmentProcedure: string;
    sourcePath: string;
    sourceSha256: string;
}

let catalogCache: Pub1075ControlRequirement[] | null = null;

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function compact(value: string, maxChars: number): string {
    const normalized = value
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
    return normalized.length <= maxChars
        ? normalized
        : `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function substantivePub1075Sections(fullText: string): Map<string, string> {
    const lines = fullText.split("\n");
    const candidates = new Map<string, string[]>();
    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(CONTROL_HEADER);
        if (!match) continue;
        const controlId = normalizeNistControlId(match[1]);
        if (!controlId) continue;
        const block = [lines[index]];
        for (let cursor = index + 1; cursor < lines.length; cursor++) {
            if (CONTROL_HEADER.test(lines[cursor])) break;
            block.push(lines[cursor]);
        }
        const text = block.join("\n").trim();
        candidates.set(controlId, [...(candidates.get(controlId) || []), text]);
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

function assessmentProcedure(control: NistControlReference): string {
    const methods = (control.assessmentMethods || []).flatMap((method) => {
        const objects = (method.assessmentObjects || [])
            .map((object) => object.text?.trim())
            .filter((value): value is string => Boolean(value));
        const label = (method.method || method.label || "EXAMINE").trim().toUpperCase();
        return objects.length > 0
            ? [`${label}: ${objects.join("; ")}`]
            : [];
    });
    if (methods.length > 0) return compact(methods.join("\n"), 4000);
    return `Examine applicable policies, procedures, configurations, records, and implementation evidence to determine whether ${control.id} ${control.title} is applicable and implemented for systems that receive, process, store, or transmit FTI.`;
}

export function listPub1075ControlRequirements(): Pub1075ControlRequirement[] {
    if (catalogCache) return catalogCache;
    verifyComplianceSourceIntegrity();
    const pubPath = path.join(process.cwd(), PUB1075_SOURCE_PATH);
    const nistPath = path.join(process.cwd(), NIST_SOURCE_PATH);
    const pubText = fs.readFileSync(pubPath, "utf8");
    const nist = JSON.parse(fs.readFileSync(nistPath, "utf8")) as {
        controls?: NistControlReference[];
    };
    const nistById = new Map((nist.controls || []).map((control) => [control.id, control]));
    const sourceSha256 = sha256(pubText);
    catalogCache = [...substantivePub1075Sections(pubText)]
        .map(([controlId, pub1075Text]) => {
            const reference = nistById.get(controlId);
            if (!reference) return null;
            return {
                controlId,
                title: reference.title,
                pub1075Text: compact(pub1075Text, 6000),
                nistStatement: compact(reference.statement || "", 3000),
                nistGuidance: compact(reference.guidance || "", 3000),
                assessmentProcedure: assessmentProcedure(reference),
                sourcePath: PUB1075_SOURCE_PATH,
                sourceSha256,
            };
        })
        .filter((value): value is Pub1075ControlRequirement => Boolean(value))
        .sort((left, right) => left.controlId.localeCompare(right.controlId, undefined, { numeric: true }));
    return catalogCache;
}

export function selectComplianceGapTargetSheet(
    parsed: ParsedSCSEM,
    controls: SCSEMControlEvidence[]
): string | null {
    const testSheets = parsed.sheets.filter((sheet) => sheet.sheetType === "test_cases");
    if (testSheets.length === 0) return null;
    const pubIds = new Set(listPub1075ControlRequirements().map((requirement) => requirement.controlId));
    const scoreBySheet = new Map<string, number>();
    for (const control of controls) {
        const normalized = normalizeNistControlId(control.nistId);
        const score = normalized && pubIds.has(normalized) ? 1 : 0;
        scoreBySheet.set(control.sourceSheet || "", (scoreBySheet.get(control.sourceSheet || "") || 0) + score);
    }
    return [...testSheets]
        .sort((left, right) => {
            const general = (name: string) => /\b(?:gen|general|common|base)\b/i.test(name) ? 1 : 0;
            return general(right.sheetName) - general(left.sheetName) ||
                (scoreBySheet.get(right.sheetName) || 0) - (scoreBySheet.get(left.sheetName) || 0) ||
                right.controls.length - left.controls.length;
        })[0]?.sheetName || null;
}

export function buildMissingPub1075ControlCandidates({
    parsed,
    controls,
    pub1075Version,
    nistVersion,
    maxCandidates = 500,
}: {
    parsed: ParsedSCSEM;
    controls: SCSEMControlEvidence[];
    pub1075Version: string;
    nistVersion: string;
    maxCandidates?: number;
}): any[] {
    const presentIds = new Set(
        controls.map((control) => normalizeNistControlId(control.nistId))
            .filter((value): value is string => Boolean(value))
    );
    const targetSheet = selectComplianceGapTargetSheet(parsed, controls);
    if (!targetSheet) return [];

    return listPub1075ControlRequirements()
        .filter((requirement) => !presentIds.has(requirement.controlId))
        .slice(0, Math.max(0, Math.min(maxCandidates, 500)))
        .map((requirement) => ({
            action: "addControl" as const,
            testId: `NEW-PUB1075-${requirement.controlId}`,
            targetSheet,
            field: "newControl",
            currentValue: `No SCSEM row is mapped to ${requirement.controlId}.`,
            proposedValue: `Review and, if applicable, add ${requirement.controlId} ${requirement.title}`,
            reason:
                `${pub1075Version} contains an authoritative ${requirement.controlId} section, but the uploaded workbook has no row mapped to that exact control ID. ` +
                "This is a reviewer-gated applicability and missing-coverage candidate, not a conclusion that the control automatically belongs in every technology template.",
            confidence: "needs_review",
            newControl: {
                nistId: requirement.controlId,
                nistControlName: requirement.title,
                testMethod: "Examine, Interview, Test",
                sectionTitle: requirement.title,
                description: requirement.pub1075Text,
                testProcedures: requirement.assessmentProcedure,
                expectedResults:
                    `Evidence demonstrates that the applicable ${requirement.controlId} ${requirement.title} requirements in ${pub1075Version} are implemented for systems receiving, processing, storing, or transmitting FTI.`,
                findingStatement:
                    `The agency did not implement the applicable ${requirement.controlId} ${requirement.title} requirements for systems receiving, processing, storing, or transmitting FTI.`,
                criticality: "Moderate",
                issueCode: null,
                cisBenchmarkRef: null,
                recommendationNum: null,
                rationale: requirement.nistGuidance || requirement.pub1075Text,
                impact: `Missing or unverified ${requirement.controlId} coverage may leave FTI safeguards incomplete until applicability and implementation are reviewed.`,
                remediationProcedure:
                    `Determine applicability of ${requirement.controlId}, select the exact IRS issue code from this workbook, and implement and document the ${requirement.title} requirements before approval.`,
            },
            sourceEvidence: {
                evidenceTier: "compliance",
                complianceSource: "IRS Publication 1075",
                gapType: "missing_control_id",
                applicabilityReviewRequired: true,
                sourceSheet: targetSheet,
                pub1075Version,
                pub1075ControlId: requirement.controlId,
                pub1075SourcePath: requirement.sourcePath,
                pub1075SourceSha256: requirement.sourceSha256,
                nistVersion,
                nistFallback: false,
            },
        }));
}
