import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { officialSCSEMManifest } from "../src/lib/scsem-official-manifest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_WORKBOOK_COUNT = 60;
const OPERATIONS = ["update", "add"] as const;

type Operation = typeof OPERATIONS[number];

type FileEvidence = {
    sha256: string;
    sizeBytes: number;
};

type CorpusResult = {
    fileName?: string;
    file?: string;
    sha256?: string;
    sizeBytes?: number;
    outcome?: string;
    [key: string]: unknown;
};

type CorpusReport = {
    operation?: string;
    expectedWorkbookCount?: number;
    testedWorkbookCount?: number;
    counts?: { supported?: number; blocked?: number; failed?: number };
    exportArtifacts?: {
        directory?: string | null;
        count?: number;
        files?: Array<Record<string, unknown>>;
    };
    results?: CorpusResult[];
    [key: string]: unknown;
};

function requiredDirectory(environmentName: string): string {
    const configured = process.env[environmentName]?.trim();
    assert.ok(configured, `${environmentName} is required`);
    const directory = path.resolve(configured);
    assert.ok(fs.existsSync(directory) && fs.statSync(directory).isDirectory(), `${environmentName} is not a directory: ${directory}`);
    return directory;
}

function fileEvidence(filePath: string): FileEvidence {
    const startedAt = process.hrtime.bigint();
    process.stdout.write(`Hashing ${filePath} ... `);
    const bytes = fs.readFileSync(filePath);
    const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    process.stdout.write(`done (${bytes.length} bytes, ${elapsedMilliseconds.toFixed(0)} ms)\n`);
    return {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
    };
}

function updatedSCSEMFileName(originalFileName: string): string {
    const originalExtension = path.extname(originalFileName);
    const extension = originalExtension.toLowerCase() === ".xlsm" ? ".xlsm" : ".xlsx";
    const base = path.basename(originalFileName, originalExtension || extension)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "Safeguards-SCSEM";
    return `${base}-updated${extension}`;
}

function readCorpusReport(reportPath: string): CorpusReport {
    assert.ok(fs.existsSync(reportPath), `Corpus report is missing: ${reportPath}`);
    return JSON.parse(fs.readFileSync(reportPath, "utf8")) as CorpusReport;
}

const finalExportRoot = requiredDirectory("SCSEM_CORPUS_FINAL_EXPORT_DIR");
const reportDirectory = requiredDirectory("SCSEM_CORPUS_REPORT_DIR");
const manifest = officialSCSEMManifest();

assert.equal(manifest.expectedWorkbookCount, EXPECTED_WORKBOOK_COUNT);
assert.equal(manifest.workbooks.length, EXPECTED_WORKBOOK_COUNT);

const operations: Record<Operation, {
    directory: string;
    count: number;
    files: Array<Record<string, unknown>>;
}> = {
    update: { directory: "", count: 0, files: [] },
    add: { directory: "", count: 0, files: [] },
};

for (const operation of OPERATIONS) {
    const exportDirectory = path.join(finalExportRoot, operation);
    assert.ok(fs.existsSync(exportDirectory) && fs.statSync(exportDirectory).isDirectory(), `${operation} export directory is missing`);
    const actualOutputNames = fs.readdirSync(exportDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith("~$") && /\.xls(?:x|m)$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    assert.equal(actualOutputNames.length, EXPECTED_WORKBOOK_COUNT, `${operation} must retain exactly 60 exports`);
    assert.equal(new Set(actualOutputNames.map((name) => name.toLocaleLowerCase("en-US"))).size, EXPECTED_WORKBOOK_COUNT);

    const reportPath = path.join(reportDirectory, `scsem-${operation}-corpus-report.json`);
    const report = readCorpusReport(reportPath);
    assert.equal(report.operation, operation);
    assert.equal(report.expectedWorkbookCount, EXPECTED_WORKBOOK_COUNT);
    assert.equal(report.testedWorkbookCount, EXPECTED_WORKBOOK_COUNT);
    assert.deepEqual(report.counts, { supported: EXPECTED_WORKBOOK_COUNT, blocked: 0, failed: 0 });
    assert.ok(Array.isArray(report.results) && report.results.length === EXPECTED_WORKBOOK_COUNT);

    const actualNameByKey = new Map(actualOutputNames.map((name) => [name.toLocaleLowerCase("en-US"), name]));
    const priorArtifacts = Array.isArray(report.exportArtifacts?.files) ? report.exportArtifacts.files : [];
    const priorByOutputName = new Map(priorArtifacts.map((artifact) => [
        String(artifact.outputFileName || "").toLocaleLowerCase("en-US"),
        artifact,
    ]));
    const resultBySourceName = new Map(report.results.map((result) => [
        String(result.fileName || "").toLocaleLowerCase("en-US"),
        result,
    ]));

    const mappings = manifest.workbooks.map((entry) => {
        const sourcePath = path.isAbsolute(entry.file) ? entry.file : path.join(ROOT, entry.file);
        assert.ok(fs.existsSync(sourcePath), `Official source is missing: ${sourcePath}`);
        const source = fileEvidence(sourcePath);
        assert.deepEqual(source, { sha256: entry.sha256, sizeBytes: entry.sizeBytes }, `Official source identity changed: ${entry.fileName}`);

        const expectedOutputName = updatedSCSEMFileName(entry.fileName);
        const actualOutputName = actualNameByKey.get(expectedOutputName.toLocaleLowerCase("en-US"));
        assert.ok(actualOutputName, `${operation} export is missing: ${expectedOutputName}`);
        const outputPath = path.join(exportDirectory, actualOutputName);
        const output = fileEvidence(outputPath);

        const prior = priorByOutputName.get(actualOutputName.toLocaleLowerCase("en-US"));
        assert.ok(prior, `${operation} corpus report does not map ${actualOutputName}`);
        assert.equal(prior.sourceFileName, entry.fileName);
        assert.equal(prior.sourcePath, entry.file);
        assert.equal(prior.sourceSha256, source.sha256);
        assert.equal(prior.outputSha256, output.sha256);
        assert.equal(prior.outputSizeBytes, output.sizeBytes);

        const result = resultBySourceName.get(entry.fileName.toLocaleLowerCase("en-US"));
        assert.ok(result, `${operation} corpus report has no result for ${entry.fileName}`);
        assert.equal(result.file, entry.file);
        assert.equal(result.sha256, source.sha256);
        assert.equal(result.outcome, "supported");
        result.sizeBytes = source.sizeBytes;

        return {
            sourceFileName: entry.fileName,
            sourcePath: entry.file,
            sourceSha256: source.sha256,
            sourceSizeBytes: source.sizeBytes,
            outputFileName: actualOutputName,
            outputPath,
            outputSha256: output.sha256,
            outputSizeBytes: output.sizeBytes,
        };
    });

    assert.equal(new Set(mappings.map((mapping) => mapping.outputFileName.toLocaleLowerCase("en-US"))).size, EXPECTED_WORKBOOK_COUNT);
    report.exportArtifacts = {
        directory: exportDirectory,
        count: mappings.length,
        files: mappings,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    operations[operation] = { directory: exportDirectory, count: mappings.length, files: mappings };
}

const totalArtifactCount = OPERATIONS.reduce((total, operation) => total + operations[operation].count, 0);
assert.equal(totalArtifactCount, EXPECTED_WORKBOOK_COUNT * OPERATIONS.length);

const consolidatedReportPath = path.join(reportDirectory, "scsem-final-export-artifacts.json");
fs.writeFileSync(consolidatedReportPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceManifest: path.join(ROOT, "data", "scsem-manifest.json"),
    expectedWorkbookCountPerOperation: EXPECTED_WORKBOOK_COUNT,
    totalArtifactCount,
    operations,
}, null, 2)}\n`);

process.stdout.write(
    `Verified ${operations.update.count} update exports and ${operations.add.count} add-control exports ` +
    `(${totalArtifactCount} total) with source/output SHA-256 and byte-size mappings.\n` +
    `REPORT ${consolidatedReportPath}\n`
);
