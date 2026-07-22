import type { SCSEMUpdaterChange } from "@/lib/scsem-updater-store";

const MAX_SUMMARY_CHARS = 2_000;
const MAX_FIELD_CHARS = 20_000;
const REQUIRED_NEW_CONTROL_FIELDS = [
    "sectionTitle",
    "description",
    "testProcedures",
    "expectedResults",
    "issueCode",
] as const;
const CRITICALITIES = new Set([
    "Critical",
    "Significant",
    "Moderate",
    "Limited",
    "Informational",
]);
const ILLEGAL_XML_10_CHARACTER = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function equivalent(left: unknown, right: unknown): boolean {
    const normalize = (value: unknown) => text(value).replace(/\s+/g, " ").toLowerCase();
    return normalize(left) === normalize(right);
}

export function approvedProposalValidationErrors(change: SCSEMUpdaterChange): string[] {
    const errors: string[] = [];
    if (typeof change.proposedValue === "string" && ILLEGAL_XML_10_CHARACTER.test(change.proposedValue)) {
        errors.push("proposedValue contains a character that is illegal in XML 1.0");
    }
    if (!text(change.proposedValue)) errors.push("proposedValue must not be blank");
    if (String(change.proposedValue || "").length > MAX_SUMMARY_CHARS && change.action === "addControl") {
        errors.push(`proposedValue exceeds ${MAX_SUMMARY_CHARS} characters`);
    }

    if (change.action === "updateField") {
        if (String(change.proposedValue || "").length > MAX_FIELD_CHARS) {
            errors.push(`proposedValue exceeds ${MAX_FIELD_CHARS} characters`);
        }
        if (equivalent(change.currentValue, change.proposedValue)) {
            errors.push("proposedValue is not materially different from currentValue");
        }
        return errors;
    }

    const control = change.newControl;
    if (!control) return [...errors, "newControl is required"];
    for (const field of REQUIRED_NEW_CONTROL_FIELDS) {
        if (!text(control[field])) errors.push(`newControl.${field} must not be blank`);
    }
    if (!text(control.recommendationNum) && !text(control.nistId)) {
        errors.push("newControl requires a benchmark recommendation number or NIST control ID");
    }
    if (text(control.nistId) && !/^[A-Z]{2,3}-\d+(?:\(\d+\))?$/i.test(text(control.nistId))) {
        errors.push("newControl.nistId is not a normalized NIST control ID");
    }
    if (text(control.criticality) && !CRITICALITIES.has(text(control.criticality))) {
        errors.push("newControl.criticality is not an allowed value");
    }
    for (const [field, value] of Object.entries(control)) {
        if (typeof value === "string" && ILLEGAL_XML_10_CHARACTER.test(value)) {
            errors.push(`newControl.${field} contains a character that is illegal in XML 1.0`);
        }
        if (typeof value === "string" && value.length > MAX_FIELD_CHARS) {
            errors.push(`newControl.${field} exceeds ${MAX_FIELD_CHARS} characters`);
        }
    }
    return errors;
}
