import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
async function main() {
    assert.ok(fs.existsSync("src/components/scsem-generator-evidence-editor.tsx"), "generator review must expose actionable quote and applicability fields");
    const { GeneratorEvidenceEditor } = await import("../src/components/scsem-generator-evidence-editor");
    const html = renderToStaticMarkup(React.createElement(GeneratorEvidenceEditor, {
        sessionId: "synthetic", change: { id: "synthetic-change", status: "PENDING", action: "addControl", testId: "SYNTHETIC", field: "newControl", currentValue: "", proposedValue: "Synthetic", reason: "Synthetic", newControl: { nistId: "CM-6" }, sourceEvidence: { sourceRemediation: "Enable synthetic logging.", sourceSheet: "Synthetic sheet", sourceRow: 42 } }, onChange: () => {},
    }));
    for (const label of ["Expected-results source quote", "Pass-criterion rationale", "Technology/profile applicability rationale", "Load pinned policy excerpts", "Enable synthetic logging.", "Synthetic sheet", "42"]) assert.ok(html.includes(label), label);
    const parent = fs.readFileSync("src/components/scsem-updater.tsx", "utf8");
    assert.ok(parent.includes("<GeneratorEvidenceEditor"));
    assert.ok(parent.includes("reviewerEvidence:"));
    assert.ok(parent.includes("data.changes"), "show actionable server validation errors rather than generic failure");
    console.log("PASS: rendered generator editor exposes immutable source, quote, rationale and pinned-mapping action; review UI wires evidence and actionable errors");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
