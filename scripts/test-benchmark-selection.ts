import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  fetchAllBenchmarks,
  getCISToken,
  type CISBenchmark,
  type CISExcelFile,
} from "../src/lib/cis-api";
import {
  rankCISBenchmarkCandidatesForTechnology,
  saveCISBenchmarkSnapshot,
} from "../src/lib/cis-benchmark-xlsx";

function benchmark(
  workbenchId: number,
  title: string,
  status: string,
  version = "1.0.0"
): CISBenchmark {
  return {
    workbenchId,
    benchmarkId: String(workbenchId),
    benchmarkTitle: title,
    benchmarkVersion: version,
    benchmarkStatus: { status, statusDate: "2026-07-10" },
    assessmentStatus: "Manual",
    availableFormats: ["Excel"],
    profile: [],
  };
}

function excel(workbenchId: number, title: string): CISExcelFile {
  return {
    workbenchId,
    excelTitle: title,
    benchmarkTitle: title,
    excelFileName: `${workbenchId}.xlsx`,
  };
}

async function assertCredentialLoadingFailsClosed() {
  const previousPath = process.env.CIS_LICENSE_XML_PATH;
  const previousBase64 = process.env.CIS_LICENSE_XML_BASE64;
  try {
    delete process.env.CIS_LICENSE_XML_PATH;
    delete process.env.CIS_LICENSE_XML_BASE64;
    await assert.rejects(getCISToken(), /credentials are not configured/);

    process.env.CIS_LICENSE_XML_BASE64 = Buffer.from("not XML", "utf8").toString("base64");
    await assert.rejects(getCISToken(), /not valid XML/);
  } finally {
    if (previousPath === undefined) delete process.env.CIS_LICENSE_XML_PATH;
    else process.env.CIS_LICENSE_XML_PATH = previousPath;
    if (previousBase64 === undefined) delete process.env.CIS_LICENSE_XML_BASE64;
    else process.env.CIS_LICENSE_XML_BASE64 = previousBase64;
  }
}

async function assertCatalogResponsesAreValidated() {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ unexpected: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(
      fetchAllBenchmarks("test-token"),
      /did not contain a benchmark list/
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function main() {
  const accepted = benchmark(
    101,
    "CIS Microsoft Windows Server 2022 Benchmark v1.0.0",
    "Accepted",
    "1.0.0"
  );
  const draft = benchmark(
    102,
    "CIS Microsoft Windows Server 2022 Benchmark v9.0.0",
    "Draft",
    "9.0.0"
  );
  const missingStatus = benchmark(
    103,
    "CIS Microsoft Windows Server 2022 Benchmark v10.0.0",
    "",
    "10.0.0"
  );
  const crossGeneration = benchmark(
    104,
    "CIS Microsoft Windows Server 2019 Benchmark v4.0.0",
    "Accepted",
    "4.0.0"
  );
  const cisStig = benchmark(
    105,
    "CIS Microsoft Windows Server 2022 STIG Benchmark v2.0.0",
    "Accepted",
    "2.0.0"
  );
  const benchmarks = [draft, accepted, missingStatus, crossGeneration, cisStig];
  const excelFiles = benchmarks.map((candidate) =>
    excel(candidate.workbenchId, candidate.benchmarkTitle)
  );

  const normal = rankCISBenchmarkCandidatesForTechnology(
    "Microsoft Windows Server 2022",
    benchmarks,
    excelFiles,
    "benchmark"
  );
  assert.deepEqual(normal.candidates.map((candidate) => candidate.benchmark.workbenchId), [101]);
  assert.match(
    normal.diagnostics.find((candidate) => candidate.workbenchId === 102)?.rejectionReasons.join(" ") || "",
    /publication status is draft/
  );
  assert.match(
    normal.diagnostics.find((candidate) => candidate.workbenchId === 103)?.rejectionReasons.join(" ") || "",
    /publication status is missing/
  );
  assert.match(
    normal.diagnostics.find((candidate) => candidate.workbenchId === 104)?.rejectionReasons.join(" ") || "",
    /product generation mismatch/
  );
  assert.match(
    normal.diagnostics.find((candidate) => candidate.workbenchId === 105)?.rejectionReasons.join(" ") || "",
    /STIG benchmark requested separately/
  );

  const stig = rankCISBenchmarkCandidatesForTechnology(
    "Microsoft Windows Server 2022",
    benchmarks,
    excelFiles,
    "stig"
  );
  assert.deepEqual(stig.candidates.map((candidate) => candidate.benchmark.workbenchId), [105]);

  const previousRuntimeDataDir = process.env.SKYSHIELD_RUNTIME_DATA_DIR;
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-cis-cas-"));
  try {
    process.env.SKYSHIELD_RUNTIME_DATA_DIR = snapshotRoot;
    const firstBytes = Buffer.from("first immutable licensed workbook", "utf8");
    const secondBytes = Buffer.from("republished bytes under the same CIS name", "utf8");
    const snapshotExcel = excel(accepted.workbenchId, accepted.benchmarkTitle);
    snapshotExcel.excelFileName = "same-name.xlsx";
    const first = saveCISBenchmarkSnapshot(accepted, snapshotExcel, firstBytes);
    const firstAgain = saveCISBenchmarkSnapshot(accepted, snapshotExcel, firstBytes);
    const second = saveCISBenchmarkSnapshot(accepted, snapshotExcel, secondBytes);
    const firstHash = createHash("sha256").update(firstBytes).digest("hex");
    const secondHash = createHash("sha256").update(secondBytes).digest("hex");

    assert.equal(first.filePath, firstAgain.filePath);
    assert.equal(first.downloadedAt.toISOString(), firstAgain.downloadedAt.toISOString());
    assert.notEqual(first.filePath, second.filePath);
    assert.ok(first.filePath.includes(path.join("101", firstHash)));
    assert.ok(second.filePath.includes(path.join("101", secondHash)));
    assert.deepEqual(fs.readFileSync(first.filePath), firstBytes);
    assert.deepEqual(fs.readFileSync(second.filePath), secondBytes);
    assert.equal(fs.statSync(first.filePath).mode & 0o077, 0);
    assert.equal(fs.statSync(`${first.filePath}.metadata.json`).mode & 0o077, 0);

    fs.writeFileSync(first.filePath, "tampered", { mode: 0o600 });
    assert.throws(
      () => saveCISBenchmarkSnapshot(accepted, snapshotExcel, firstBytes),
      /integrity validation/
    );
  } finally {
    if (previousRuntimeDataDir === undefined) {
      delete process.env.SKYSHIELD_RUNTIME_DATA_DIR;
    } else {
      process.env.SKYSHIELD_RUNTIME_DATA_DIR = previousRuntimeDataDir;
    }
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }

  await assertCredentialLoadingFailsClosed();
  await assertCatalogResponsesAreValidated();
  console.log("CIS WorkBench credential and benchmark-selection tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
