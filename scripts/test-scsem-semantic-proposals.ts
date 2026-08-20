import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    buildDisaStigChanges,
    parseSelectedDisaStigBenchmarksFromZip,
    resolveDisaStigCatalogSources,
    type ResolvedDisaStigSource,
} from "../src/lib/disa-stig";
import { extractComplianceEvidence } from "../src/lib/compliance-evidence";
import { buildMissingPub1075ControlCandidates } from "../src/lib/scsem-compliance-gap-candidates";
import { validateChanges, type SCSEMControlEvidence } from "../src/lib/scsem-update-engine";
import { parseSCSEMFile, type ParsedSCSEM } from "../src/lib/xlsx-parser";

function controlsFrom(parsed: ParsedSCSEM): SCSEMControlEvidence[] {
    return parsed.sheets.filter((sheet) => sheet.sheetType === "test_cases")
        .flatMap((sheet) => sheet.controls.map((control) => ({
            id: `${sheet.sheetName}:${control.rowIndex}`,
            sourceSheet: sheet.sheetName,
            testId: control.testId,
            nistId: control.nistId,
            nistControlName: control.nistControlName,
            testMethod: control.testMethod,
            sectionTitle: control.sectionTitle,
            description: control.description,
            testProcedures: control.testProcedures,
            expectedResults: control.expectedResults,
            findingStatement: control.findingStatement,
            criticality: control.criticality,
            cisBenchmarkRef: control.cisBenchmarkRef,
            recommendationNum: control.recommendationNum,
            rationale: control.rationale,
            impact: control.impact,
            remediationProcedure: control.remediationProcedure,
        })));
}

async function main(): Promise<void> {
    const corpusDir = path.join(process.cwd(), "data", "scsems", "current");
    const snapshotDir = path.join(process.cwd(), "data", "disa-stig");
    const snapshotNames = fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir) : [];
    const useVerifiedLiveSnapshots = snapshotNames.length > 0;
    const manifest = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "data", "scsem-manifest.json"), "utf8")
    ) as { workbooks: Array<{ fileName: string; sha256: string }> };
    const officialByFile = new Map(manifest.workbooks.map((entry) => [entry.fileName, entry]));
    const reports: Array<{
        fileName: string;
        controls: number;
        pub1075Candidates: number;
        directDisaSources: number;
        adjacentDisaSources: number;
        disaCandidates: number;
        validatedCandidates: number;
    }> = [];

    for (const fileName of fs.readdirSync(corpusDir).filter((candidate) => /\.xlsx$/i.test(candidate)).sort()) {
        const parsed = parseSCSEMFile(path.join(corpusDir, fileName));
        const controls = controlsFrom(parsed);
        const compliance = extractComplianceEvidence(controls.map((control) => control.nistId));
        const pub1075Candidates = buildMissingPub1075ControlCandidates({
            parsed,
            controls,
            pub1075Version: compliance.pub1075.version,
            nistVersion: compliance.nist.version,
        });
        const sources = resolveDisaStigCatalogSources({
            technology: parsed.metadata.subject || fileName,
            parsed,
            officialSource: officialByFile.get(fileName),
        });
        const directSources = sources.filter((source) => source.sourceRelationship === "direct");
        const disaCandidates: any[] = [];
        for (const source of directSources) {
            const suffix = `-${source.expectedPackageSha256.slice(0, 16)}.zip`;
            if (!useVerifiedLiveSnapshots) continue;
            const snapshotName = snapshotNames.find((candidate) => candidate.endsWith(suffix));
            assert.ok(snapshotName, `${fileName} is missing verified DISA package ${suffix}`);
            const snapshotPath = path.join(snapshotDir, snapshotName);
            const parsedStig = await parseSelectedDisaStigBenchmarksFromZip(
                fs.readFileSync(snapshotPath),
                source.benchmarkIds
            );
            const resolved: ResolvedDisaStigSource = {
                ...source,
                packageSha256: source.expectedPackageSha256,
                downloadedAt: new Date(0).toISOString(),
                snapshotPath,
                parsed: parsedStig,
            };
            disaCandidates.push(...buildDisaStigChanges({
                source: resolved,
                controls,
                pub1075Version: compliance.pub1075.version,
                nistVersion: compliance.nist.version,
            }));
        }
        const combined = [...pub1075Candidates, ...disaCandidates];
        const validated = validateChanges(combined, controls, 5000);
        assert.ok(pub1075Candidates.length > 0, `${fileName} needs explicit Pub 1075 applicability candidates`);
        assert.equal(validated.length, combined.length, `${fileName} lost deterministic candidates in validation`);
        reports.push({
            fileName,
            controls: controls.length,
            pub1075Candidates: pub1075Candidates.length,
            directDisaSources: directSources.length,
            adjacentDisaSources: sources.filter((source) => source.sourceRelationship === "adjacent").length,
            disaCandidates: disaCandidates.length,
            validatedCandidates: validated.length,
        });
    }

    assert.equal(reports.length, 60);
    const db2 = reports.find((report) => report.fileName.includes("db2-luw-zos"));
    assert.ok(db2);
    assert.equal(db2.directDisaSources, 0, "DB2 10.5 STIG must not be treated as direct for DB2 11/13");
    assert.ok(db2.adjacentDisaSources > 0);
    assert.ok(db2.validatedCandidates > 0);
    for (const token of ["application-v4-1", "windows-server- 2025", "microsoft-sql-server", "apache24-iis"]) {
        const report = reports.find((candidate) => candidate.fileName.includes(token));
        assert.ok(report && report.directDisaSources > 0, `${token} needs a direct DISA source`);
        if (useVerifiedLiveSnapshots) {
            assert.ok(report.disaCandidates > 0, `${token} needs source-bound DISA proposals`);
        }
    }

    const summary = {
        workbooks: reports.length,
        controls: reports.reduce((total, report) => total + report.controls, 0),
        pub1075Candidates: reports.reduce((total, report) => total + report.pub1075Candidates, 0),
        directDisaWorkbookMatches: reports.filter((report) => report.directDisaSources > 0).length,
        adjacentDisaWorkbookMatches: reports.filter((report) => report.adjacentDisaSources > 0).length,
        disaCandidates: reports.reduce((total, report) => total + report.disaCandidates, 0),
        validatedCandidates: reports.reduce((total, report) => total + report.validatedCandidates, 0),
        verifiedLiveSnapshots: useVerifiedLiveSnapshots,
        zeroDisaGapDirectMatches: reports.filter((report) => report.directDisaSources > 0 && report.disaCandidates === 0).map((report) => report.fileName),
    };
    fs.writeFileSync("/tmp/scsem-semantic-proposal-report.json", `${JSON.stringify({ summary, reports }, null, 2)}\n`);
    console.log(JSON.stringify(summary));
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
