import * as fs from "fs";
import * as path from "path";

const DEFAULT_SOURCE_URL =
    "https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json";

type OscalPart = {
    name?: string;
    prose?: string;
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

function normalizeControls(controls: OscalControl[]): Array<{
    id: string;
    title: string;
    statement: string;
    guidance: string;
}> {
    return controls.flatMap((control) => [
        {
            id: normalizeControlId(control.id),
            title: compactText(control.title || ""),
            statement: textForPart(control, "statement"),
            guidance: textForPart(control, "guidance"),
        },
        ...normalizeControls(control.controls || []),
    ]);
}

async function main() {
    const sourceUrl = process.env.NIST_80053_OSCAL_URL || DEFAULT_SOURCE_URL;
    const response = await fetch(sourceUrl, {
        headers: { Accept: "application/json" },
    });
    if (!response.ok) {
        throw new Error(`NIST OSCAL download failed (${response.status} ${response.statusText}).`);
    }

    const source = await response.json() as any;
    const catalog = source?.catalog;
    if (!catalog?.metadata || !Array.isArray(catalog.groups)) {
        throw new Error("NIST OSCAL response did not contain a control catalog.");
    }

    const controls = normalizeControls(
        catalog.groups.flatMap((group: { controls?: OscalControl[] }) => group.controls || [])
    ).filter((control) => control.id && control.title && control.statement);

    const output = {
        title: catalog.metadata.title,
        version: catalog.metadata.version,
        lastModified: catalog.metadata["last-modified"],
        sourceUrl,
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

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
