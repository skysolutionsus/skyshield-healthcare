import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractComplianceEvidence } from "../src/lib/compliance-evidence";
import {
    ComplianceSourceIntegrityError,
    verifyComplianceSourceIntegrity,
} from "../src/lib/compliance-source-integrity";
import {
    normalizeOscalControls,
    resolveNistSourceConfig,
} from "./sync-nist-80053";

const integrityManifest = verifyComplianceSourceIntegrity();
assert.equal(integrityManifest.pub1075.version, "Rev. 11-2021");
assert.equal(integrityManifest.nist.version, "5.2.0");
assert.match(integrityManifest.nist.sourceCommit, /^[0-9a-f]{40}$/);

const tamperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-compliance-integrity-"));
try {
    for (const relativePath of [
        "data/compliance-source-manifest.json",
        integrityManifest.pub1075.text.path,
        integrityManifest.pub1075.publication.path,
        integrityManifest.nist.path,
    ]) {
        const sourcePath = path.join(process.cwd(), relativePath);
        const targetPath = path.join(tamperRoot, relativePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
    }

    verifyComplianceSourceIntegrity(tamperRoot);
    fs.appendFileSync(
        path.join(tamperRoot, integrityManifest.pub1075.text.path),
        "\nunauthorized mutation"
    );
    assert.throws(
        () => verifyComplianceSourceIntegrity(tamperRoot),
        (error: unknown) =>
            error instanceof ComplianceSourceIntegrityError &&
            error.message === "Pinned compliance source integrity verification failed."
    );
    fs.copyFileSync(
        path.join(process.cwd(), integrityManifest.pub1075.text.path),
        path.join(tamperRoot, integrityManifest.pub1075.text.path)
    );
    fs.appendFileSync(
        path.join(tamperRoot, integrityManifest.nist.path),
        "\n"
    );
    assert.throws(
        () => verifyComplianceSourceIntegrity(tamperRoot),
        (error: unknown) => error instanceof ComplianceSourceIntegrityError
    );
} finally {
    fs.rmSync(tamperRoot, { recursive: true, force: true });
}

const budgetConstrained = extractComplianceEvidence(["AC-2"], {
    maxPubCharsPerControl: 1,
    maxNistCharsPerControl: 1,
    maxTotalChars: 0,
});
assert.deepEqual(budgetConstrained.pub1075.controlIds, ["AC-2"]);
assert.deepEqual(budgetConstrained.pub1075.excerptedControlIds, []);
assert.deepEqual(budgetConstrained.nist.controlIds, []);
assert.deepEqual(budgetConstrained.uncoveredControlIds, []);

const assessmentEvidence = extractComplianceEvidence(["AC-2"], {
    maxTotalChars: 20_000,
});
assert.deepEqual(assessmentEvidence.nist.assessmentControlIds, ["AC-2"]);
assert.match(assessmentEvidence.nist.assessmentExcerpts, /NIST SP 800-53A AC-2 Account Management/);
assert.match(assessmentEvidence.nist.assessmentExcerpts, /EXAMINE:/);
assert.match(assessmentEvidence.excerpts, /SUPPLEMENTAL ASSESSMENT OBJECTIVES AND METHODS/);

const nonexistentEnhancement = extractComplianceEvidence(["AC-2(99)"]);
assert.deepEqual(nonexistentEnhancement.pub1075.controlIds, []);
assert.deepEqual(nonexistentEnhancement.nist.controlIds, []);
assert.deepEqual(nonexistentEnhancement.uncoveredControlIds, ["AC-2(99)"]);

const pinnedSource = resolveNistSourceConfig({});
assert.match(pinnedSource.sourceCommit, /^[0-9a-f]{40}$/);
assert.ok(pinnedSource.sourceUrl.includes(pinnedSource.sourceCommit));
assert.throws(
    () => resolveNistSourceConfig({
        NIST_80053_OSCAL_URL:
            "https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json",
        NIST_80053_OSCAL_COMMIT: pinnedSource.sourceCommit,
    }),
    /full immutable commit/
);

const [normalized] = normalizeOscalControls([{
    id: "ac-2",
    title: "Account Management",
    params: [{ id: "ac-02_odp.01", label: "defined conditions" }],
    parts: [
        {
            id: "ac-2_smt",
            name: "statement",
            prose: "Require {{ insert: param, ac-02_odp.01 }}.",
        },
        {
            id: "ac-2_obj",
            name: "assessment-objective",
            props: [{ name: "label", value: "AC-02" }],
            parts: [{
                id: "ac-2_obj.a",
                name: "assessment-objective",
                props: [{ name: "label", value: "AC-02a." }],
                prose: "the {{ insert: param, ac-02_odp.01 }} are documented;",
            }],
        },
        {
            id: "ac-2_asm-examine",
            name: "assessment-method",
            props: [
                { name: "method", value: "EXAMINE" },
                { name: "label", value: "AC-02-Examine" },
            ],
            parts: [{
                id: "ac-2_objects",
                name: "assessment-objects",
                prose: "Access control policy and account records",
            }],
        },
    ],
}] as any);
assert.equal(normalized.statement, "Require [defined conditions].");
assert.deepEqual(normalized.assessmentObjectives, [{
    id: "ac-2_obj",
    label: "AC-02",
    text: "",
    children: [{
        id: "ac-2_obj.a",
        label: "AC-02a.",
        text: "the [defined conditions] are documented;",
        children: [],
    }],
}]);
assert.deepEqual(normalized.assessmentMethods, [{
    id: "ac-2_asm-examine",
    label: "AC-02-Examine",
    method: "EXAMINE",
    assessmentObjects: [{
        id: "ac-2_objects",
        title: "",
        text: "Access control policy and account records",
    }],
}]);

console.log("Compliance evidence authority and NIST OSCAL sync tests passed.");
