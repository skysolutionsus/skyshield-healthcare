import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import {
    buildDisaStigChanges,
    parseDisaStigXccdf,
    parseSelectedDisaStigBenchmarksFromZip,
    resolveDisaStigCatalogSources,
    type ResolvedDisaStigSource,
} from "../src/lib/disa-stig";
import type { SCSEMControlEvidence } from "../src/lib/scsem-update-engine";
import { parseSCSEMFile } from "../src/lib/xlsx-parser";

const xml = Buffer.from(`<?xml version="1.0"?>
<Benchmark xmlns="http://checklists.nist.gov/xccdf/1.1" id="synthetic" version="1">
<title>Synthetic DB2 STIG</title><plain-text id="release-info">Release: 1</plain-text>
<Group id="G-1"><Rule id="SV-1_rule" severity="medium"><version>DB2X-00-000200</version>
<title>Limit concurrent DB2 sessions.</title><description>&lt;VulnDiscussion&gt;Concurrent sessions must be limited.&lt;/VulnDiscussion&gt;</description>
<ident system="http://cyber.mil/legacy">V-74429</ident><ident system="http://cyber.mil/cci">CCI-000054</ident>
<check><check-content>Examine the DB2 concurrent-session configuration.</check-content></check>
<fixtext>Configure the approved concurrent-session limit.</fixtext></Rule></Group></Benchmark>`);
const parsedXccdf = parseDisaStigXccdf(xml);
assert.equal(parsedXccdf.rules.length, 1);
assert.equal(parsedXccdf.rules[0].version, "DB2X-00-000200");
assert.ok(parsedXccdf.rules[0].nistIds.includes("AC-10"));
assert.equal(parsedXccdf.rules[0].vulnerabilityId, "V-74429");
const enhancementXccdf = parseDisaStigXccdf(Buffer.from(
    xml.toString().replace("CCI-000054", "CCI-000015")
));
assert.deepEqual(enhancementXccdf.rules[0].nistIds, ["AC-2(1)"]);

async function main(): Promise<void> {
const selectedZip = new JSZip();
selectedZip.file("wanted-manual-xccdf.xml", xml.toString().replace('id="synthetic"', 'id="wanted"'));
selectedZip.file(
    "other-manual-xccdf.xml",
    xml.toString()
        .replace('id="synthetic"', 'id="other"')
        .replaceAll("DB2X-00-000200", "OTHER-00-000200")
        .replaceAll("SV-1_rule", "SV-other_rule")
);
const supplementalZip = new JSZip();
supplementalZip.file(
    "wanted-old-manual-xccdf.xml",
    xml.toString()
        .replace('id="synthetic"', 'id="wanted"')
        .replaceAll("DB2X-00-000200", "OLD-00-000200")
        .replaceAll("SV-1_rule", "SV-old_rule")
);
selectedZip.file("U_Product_Supplemental/old.zip", await supplementalZip.generateAsync({ type: "nodebuffer" }));
const selectedBenchmarks = await parseSelectedDisaStigBenchmarksFromZip(
    await selectedZip.generateAsync({ type: "nodebuffer" }),
    ["wanted"]
);
assert.deepEqual(selectedBenchmarks.benchmarkIds, ["wanted"]);
assert.equal(selectedBenchmarks.rules.length, 1);
assert.equal(selectedBenchmarks.rules[0].benchmarkId, "wanted");
assert.equal(selectedBenchmarks.rules[0].version, "DB2X-00-000200");
await assert.rejects(
    () => parseSelectedDisaStigBenchmarksFromZip(
        Buffer.from("PK\u0003\u0004"),
        ["absent"]
    )
);

const corpusDir = path.join(process.cwd(), "data", "scsems", "current");
const files = fs.readdirSync(corpusDir).filter((fileName) => /\.xlsx$/i.test(fileName)).sort();
const officialByFile = new Map(
    (JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "scsem-manifest.json"), "utf8")) as {
        workbooks: Array<{ fileName: string; sha256: string }>;
    }).workbooks.map((entry) => [entry.fileName, entry])
);
const sourceReports: Array<{ fileName: string; direct: number; adjacent: number }> = [];
let db2Sources: ReturnType<typeof resolveDisaStigCatalogSources> = [];
for (const fileName of files) {
    const parsed = parseSCSEMFile(path.join(corpusDir, fileName));
    const sources = resolveDisaStigCatalogSources({
        technology: parsed.metadata.subject || fileName,
        parsed,
        officialSource: officialByFile.get(fileName),
    });
    sourceReports.push({
        fileName,
        direct: sources.filter((source) => source.sourceRelationship === "direct").length,
        adjacent: sources.filter((source) => source.sourceRelationship === "adjacent").length,
    });
    if (fileName.includes("db2-luw-zos")) db2Sources = sources.filter((source) => source.catalogEntry.name.includes("DB2"));
}
assert.ok(db2Sources.length > 0, "DB2 should resolve the current official DISA DB2 catalog entry");
assert.ok(
    db2Sources.some((source) =>
        source.sourceRelationship === "adjacent" && source.matchedSheets.includes("DB2 v11 Test Cases")
    ),
    "DB2 10.5 must be adjacent, not direct, for the DB2 11 sheet"
);
assert.ok(
    db2Sources.filter((source) => source.sourceRelationship === "direct")
        .every((source) => source.matchedSheets.every((sheet) => !/^DB2 v(?:11|13)/i.test(sheet))),
    "No DB2 10.5 source may be direct for DB2 11 or DB2 13"
);
const windows2025 = sourceReports.find((entry) => entry.fileName.includes("windows-server- 2025"));
assert.ok(windows2025 && windows2025.direct > 0, "Windows Server 2025 should resolve a direct current DISA STIG");

const syntheticSource: ResolvedDisaStigSource = {
    ...db2Sources[0],
    sourceRelationship: "direct",
    packageSha256: "a".repeat(64),
    downloadedAt: new Date(0).toISOString(),
    snapshotPath: "/tmp/synthetic.zip",
    parsed: parsedXccdf,
};
const controls: SCSEMControlEvidence[] = [{
    id: "DB2:1",
    sourceSheet: syntheticSource.matchedSheets[0],
    testId: "DB2-1",
    nistId: "AC-10",
    nistControlName: "Concurrent Session Control",
    testMethod: "Manual",
    sectionTitle: "Concurrent Session Control",
    description: "Sessions are limited.",
    testProcedures: "Review session settings.",
    expectedResults: "Sessions are limited.",
    findingStatement: null,
    criticality: "Moderate",
    cisBenchmarkRef: null,
    recommendationNum: null,
    rationale: null,
    impact: null,
    remediationProcedure: null,
}];
const changes = buildDisaStigChanges({
    source: syntheticSource,
    controls,
    pub1075Version: "Rev. 11-2021",
    nistVersion: "5.2.0",
});
assert.equal(changes.length, 1);
assert.equal(changes[0].action, "updateField");
assert.equal(changes[0].sourceEvidence.sourceKind, "STIG");
assert.equal(changes[0].sourceEvidence.stigVersion, "DB2X-00-000200");
assert.deepEqual(changes[0].sourceEvidence.nistControlIds, ["AC-10"]);

console.log(JSON.stringify({
    workbooks: files.length,
    directWorkbookMatches: sourceReports.filter((entry) => entry.direct > 0).length,
    adjacentWorkbookMatches: sourceReports.filter((entry) => entry.adjacent > 0).length,
    parserRules: parsedXccdf.rules.length,
}));
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
