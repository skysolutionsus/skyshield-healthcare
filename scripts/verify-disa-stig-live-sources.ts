import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    downloadAndParseDisaStigSource,
    resolveDisaStigCatalogSources,
} from "../src/lib/disa-stig";
import { parseSCSEMFile } from "../src/lib/xlsx-parser";

async function main(): Promise<void> {
    const corpusDir = path.join(process.cwd(), "data", "scsems", "current");
    const manifest = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "data", "scsem-manifest.json"), "utf8")
    ) as { workbooks: Array<{ fileName: string; sha256: string }> };
    const officialByFile = new Map(manifest.workbooks.map((entry) => [entry.fileName, entry]));
    const uniqueSources = new Map<string, ReturnType<typeof resolveDisaStigCatalogSources>[number]>();

    for (const fileName of fs.readdirSync(corpusDir).filter((candidate) => /\.xlsx$/i.test(candidate))) {
        const parsed = parseSCSEMFile(path.join(corpusDir, fileName));
        for (const source of resolveDisaStigCatalogSources({
            technology: parsed.metadata.subject || fileName,
            parsed,
            officialSource: officialByFile.get(fileName),
        })) {
            if (source.sourceRelationship !== "direct") continue;
            uniqueSources.set(
                `${source.catalogEntry.url}|${source.benchmarkIds.join(",")}`,
                source
            );
        }
    }

    const queue = [...uniqueSources.values()];
    const results: Awaited<ReturnType<typeof downloadAndParseDisaStigSource>>[] = [];
    const worker = async () => {
        while (queue.length > 0) {
            const source = queue.shift();
            if (!source) return;
            const resolved = await downloadAndParseDisaStigSource(source);
            assert.equal(resolved.packageSha256, source.expectedPackageSha256);
            assert.deepEqual(resolved.parsed.benchmarkIds, [...source.benchmarkIds].sort());
            assert.ok(resolved.parsed.rules.length > 0);
            results.push(resolved);
            console.log(JSON.stringify({
                source: source.catalogEntry.name,
                benchmarkIds: source.benchmarkIds,
                rules: resolved.parsed.rules.length,
            }));
        }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    assert.equal(results.length, uniqueSources.size);
    console.log(JSON.stringify({
        packages: results.length,
        benchmarks: results.reduce((total, result) => total + result.parsed.benchmarkIds.length, 0),
        rules: results.reduce((total, result) => total + result.parsed.rules.length, 0),
    }));
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
