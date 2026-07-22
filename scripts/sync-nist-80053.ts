import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_SOURCE_COMMIT = "78650f02ad9321bb7b817846f8fbd4f2bcd620de";
const DEFAULT_SOURCE_URL =
    `https://raw.githubusercontent.com/usnistgov/oscal-content/${DEFAULT_SOURCE_COMMIT}/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json`;

type OscalProp = {
    name?: string;
    value?: string;
    class?: string;
    ns?: string;
};

type OscalPart = {
    id?: string;
    name?: string;
    title?: string;
    prose?: string;
    props?: OscalProp[];
    parts?: OscalPart[];
};

type OscalControl = {
    id: string;
    title?: string;
    params?: Array<{
        id: string;
        label?: string;
        select?: { choice?: string[] };
    }>;
    parts?: OscalPart[];
    controls?: OscalControl[];
};

export type NormalizedAssessmentObjective = {
    id: string;
    label: string;
    text: string;
    children: NormalizedAssessmentObjective[];
};

export type NormalizedAssessmentMethod = {
    id: string;
    label: string;
    method: string;
    assessmentObjects: Array<{
        id: string;
        title: string;
        text: string;
    }>;
};

export type NormalizedNistControl = {
    id: string;
    title: string;
    statement: string;
    guidance: string;
    assessmentObjectives: NormalizedAssessmentObjective[];
    assessmentMethods: NormalizedAssessmentMethod[];
};

function normalizeControlId(value: string): string {
    const match = value.toLowerCase().match(/^([a-z]{2,3})-(\d+)(?:\.(\d+))?$/);
    if (!match) return value.toUpperCase();

    const family = match[1].toUpperCase();
    const number = String(Number.parseInt(match[2], 10));
    const enhancement = match[3]
        ? `(${Number.parseInt(match[3], 10)})`
        : "";
    return `${family}-${number}${enhancement}`;
}

function compactText(value: string): string {
    return value
        .replace(/\s+/g, " ")
        .replace(/\s+([,.;:])/g, "$1")
        .trim();
}

function parameterText(control: OscalControl, parameterId: string): string {
    const parameter = control.params?.find((candidate) => candidate.id === parameterId);
    const label = parameter?.label || parameter?.select?.choice?.join(" or ") || "organization-defined value";
    return `[${compactText(label)}]`;
}

function resolveParameters(value: string, control: OscalControl): string {
    return value.replace(
        /\{\{\s*insert:\s*param,\s*([^}\s]+)\s*\}\}/gi,
        (_match, parameterId: string) => parameterText(control, parameterId)
    );
}

function flattenPart(part: OscalPart, control: OscalControl): string[] {
    return [
        part.prose ? resolveParameters(part.prose, control) : "",
        ...(part.parts || []).flatMap((child) => flattenPart(child, control)),
    ].filter(Boolean);
}

function textForPart(control: OscalControl, partName: string): string {
    const part = control.parts?.find((candidate) => candidate.name === partName);
    return part ? compactText(flattenPart(part, control).join(" ")) : "";
}

function propertyValue(part: OscalPart, propertyName: string): string {
    return compactText(
        part.props?.find((property) => property.name === propertyName)?.value || ""
    );
}

function normalizeAssessmentObjective(
    part: OscalPart,
    control: OscalControl
): NormalizedAssessmentObjective {
    return {
        id: part.id || "",
        label: propertyValue(part, "label"),
        text: compactText(resolveParameters(part.prose || "", control)),
        children: (part.parts || [])
            .filter((child) => child.name === "assessment-objective")
            .map((child) => normalizeAssessmentObjective(child, control)),
    };
}

function normalizeAssessmentMethod(
    part: OscalPart,
    control: OscalControl
): NormalizedAssessmentMethod {
    return {
        id: part.id || "",
        label: propertyValue(part, "label"),
        method: propertyValue(part, "method").toUpperCase(),
        assessmentObjects: (part.parts || [])
            .filter((child) => child.name === "assessment-objects")
            .map((child) => ({
                id: child.id || "",
                title: compactText(child.title || ""),
                text: compactText(flattenPart(child, control).join(" ")),
            })),
    };
}

export function normalizeOscalControls(controls: OscalControl[]): NormalizedNistControl[] {
    return controls.flatMap((control) => [
        {
            id: normalizeControlId(control.id),
            title: compactText(control.title || ""),
            statement: textForPart(control, "statement"),
            guidance: textForPart(control, "guidance"),
            assessmentObjectives: (control.parts || [])
                .filter((part) => part.name === "assessment-objective")
                .map((part) => normalizeAssessmentObjective(part, control)),
            assessmentMethods: (control.parts || [])
                .filter((part) => part.name === "assessment-method")
                .map((part) => normalizeAssessmentMethod(part, control)),
        },
        ...normalizeOscalControls(control.controls || []),
    ]);
}

export function resolveNistSourceConfig(
    environment: Record<string, string | undefined> = process.env
): { sourceUrl: string; sourceCommit: string; expectedSha256: string } {
    const sourceUrl = environment.NIST_80053_OSCAL_URL?.trim() || DEFAULT_SOURCE_URL;
    const embeddedCommit = sourceUrl.match(
        /raw\.githubusercontent\.com\/usnistgov\/oscal-content\/([0-9a-f]{40})\//i
    )?.[1]?.toLowerCase();
    const declaredCommit = environment.NIST_80053_OSCAL_COMMIT?.trim().toLowerCase();
    const sourceCommit = declaredCommit || embeddedCommit || "";

    if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
        throw new Error(
            "NIST OSCAL synchronization requires an immutable 40-character source commit. " +
            "Use a commit-pinned NIST_80053_OSCAL_URL or set NIST_80053_OSCAL_COMMIT."
        );
    }
    if (embeddedCommit && embeddedCommit !== sourceCommit) {
        throw new Error(
            `NIST OSCAL source commit mismatch: URL contains ${embeddedCommit}, ` +
            `but metadata declares ${sourceCommit}.`
        );
    }
    if (/raw\.githubusercontent\.com\/usnistgov\/oscal-content\//i.test(sourceUrl) && !embeddedCommit) {
        throw new Error("NIST OSCAL GitHub URLs must contain a full immutable commit, not a branch name.");
    }

    const expectedSha256 = environment.NIST_80053_OSCAL_SHA256?.trim().toLowerCase() || "";
    if (expectedSha256 && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
        throw new Error("NIST_80053_OSCAL_SHA256 must be a 64-character SHA-256 digest.");
    }

    return { sourceUrl, sourceCommit, expectedSha256 };
}

async function main() {
    const { sourceUrl, sourceCommit, expectedSha256 } = resolveNistSourceConfig();
    const response = await fetch(sourceUrl, {
        headers: { Accept: "application/json" },
    });
    if (!response.ok) {
        throw new Error(`NIST OSCAL download failed (${response.status} ${response.statusText}).`);
    }

    const sourceBody = await response.text();
    const sourceSha256 = createHash("sha256").update(sourceBody).digest("hex");
    if (expectedSha256 && sourceSha256 !== expectedSha256) {
        throw new Error(
            `NIST OSCAL SHA-256 mismatch: expected ${expectedSha256}, received ${sourceSha256}.`
        );
    }

    const source = JSON.parse(sourceBody) as any;
    const catalog = source?.catalog;
    if (!catalog?.metadata || !Array.isArray(catalog.groups)) {
        throw new Error("NIST OSCAL response did not contain a control catalog.");
    }

    const controls = normalizeOscalControls(
        catalog.groups.flatMap((group: { controls?: OscalControl[] }) => group.controls || [])
    ).filter((control) => control.id && control.title && control.statement);

    const output = {
        title: catalog.metadata.title,
        version: catalog.metadata.version,
        lastModified: catalog.metadata["last-modified"],
        sourceUrl,
        sourceCommit,
        sourceSha256,
        publicationUrl: "https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final",
        generatedAt: new Date().toISOString(),
        controls,
    };

    const outputPath = path.join(
        process.cwd(),
        "data",
        "nist",
        "sp800-53-rev5-controls.json"
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(`Wrote ${controls.length} NIST SP 800-53 controls to ${outputPath}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
