import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import { matchOfficialSCSEM } from "../src/lib/scsem-official-manifest";
import { admitUnrecognizedSCSEMBuffer } from "../src/lib/scsem-structural-admission";

async function main() {
    const sourcePath = path.join(
        process.cwd(),
        "data",
        "scsems",
        "current",
        "safeguards-scsem-generic-db.xlsx"
    );
    const official = fs.readFileSync(sourcePath);
    assert.ok(matchOfficialSCSEM(official), "Fixture must start as a pinned IRS source");

    // Alter package metadata without changing the SCSEM worksheets. This models
    // a newly issued or program-supplied template whose hash is not yet pinned.
    const zip = await JSZip.loadAsync(official);
    zip.file("docProps/skyshield-admission-test.txt", "unverified structural source\n");
    const unrecognized = await zip.generateAsync({ type: "nodebuffer" });
    assert.equal(matchOfficialSCSEM(unrecognized), null);

    const admission = admitUnrecognizedSCSEMBuffer(
        "Safeguards-SCSEM-PostgreSQL17.xlsx",
        unrecognized
    );
    assert.equal(admission.trust, "unverified_structural_draft");
    assert.equal(admission.totalControls, 27);
    assert.deepEqual(admission.testCaseSheets, ["Test Cases"]);
    assert.ok(admission.issueCodeCount >= 547);
    assert.match(admission.sha256, /^[a-f0-9]{64}$/);
    assert.match(admission.blocker, /incomplete working draft/i);

    assert.throws(
        () => admitUnrecognizedSCSEMBuffer(
            "not-a-scsem.xlsx",
            Buffer.from("PK\x03\x04not really an OOXML workbook")
        ),
        /recognizable|zip|workbook|archive/i
    );

    process.stdout.write("Unrecognized but structurally valid SCSEM admission tests passed.\n");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
