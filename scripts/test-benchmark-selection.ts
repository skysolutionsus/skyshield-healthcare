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
  identifyCISProduct,
  isExactCISProductIdentity,
  rankCISBenchmarkCandidatesForTechnology,
  saveCISBenchmarkSnapshot,
} from "../src/lib/cis-benchmark-xlsx";
import {
  hasUnavailableApplicableBenchmarkQuery,
  isCISBenchmarkSelectionAccepted,
  scsemBenchmarkQueriesForSheet,
} from "../src/lib/scsem-benchmark-resolver";
import { parseSCSEMFile } from "../src/lib/xlsx-parser";
import {
  buildComparisonCandidates,
  buildSheetScopedComparisonCandidates,
  type SCSEMControlEvidence,
} from "../src/lib/scsem-update-engine";
import type { CISBenchmarkRecommendation } from "../src/lib/cis-benchmark-xlsx";

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

function assertDb2VersionTabsStayIndependent() {
  const db2Path = path.join(
    process.cwd(),
    "data/scsems/current/safeguards-scsem-db2-luw-zos.xlsx"
  );
  const parsed = parseSCSEMFile(db2Path);
  const testSheets = parsed.sheets.filter((sheet) => sheet.sheetType === "test_cases");

  assert.deepEqual(
    testSheets.map((sheet) => [sheet.sheetName.trim(), sheet.controls.length]),
    [
      ["Gen Test Cases", 25],
      ["DB2 v11 Test Cases", 202],
      ["DB2 v13 for z_OS Test Cases", 78],
    ],
    "the canonical DB2 workbook must parse every version tab, not only the first"
  );
  assert.deepEqual(
    scsemBenchmarkQueriesForSheet(
      "DB2 v11 Test Cases",
      "DB2 for Linux, Unix, and Windows",
      parsed
    ),
    ["IBM Db2 11"],
    "the v11 tab must not add a broad IBM Db2 query that can select another generation"
  );
  assert.deepEqual(
    scsemBenchmarkQueriesForSheet(
      "DB2 v13 for z_OS Test Cases ",
      "DB2 for Linux, Unix, and Windows",
      parsed
    ),
    ["IBM Db2 13 for z/OS"],
    "the z/OS v13 tab must retain both its platform and product generation"
  );

  assert.deepEqual(identifyCISProduct("CIS IBM Db2 11 Benchmark v2.0.0"), {
    family: "ibm-db2-distributed",
    productGeneration: "11",
  });
  assert.deepEqual(identifyCISProduct("CIS IBM Db2 13 for z/OS Benchmark v1.1.0"), {
    family: "ibm-db2-zos",
    productGeneration: "13",
  });

  const db2v11 = benchmark(201, "CIS IBM Db2 11 Benchmark v2.0.0", "Accepted", "2.0.0");
  const db2v13 = benchmark(202, "CIS IBM Db2 13 for z/OS Benchmark v1.1.0", "Accepted", "1.1.0");
  const excelFiles = [
    excel(db2v11.workbenchId, db2v11.benchmarkTitle),
    excel(db2v13.workbenchId, db2v13.benchmarkTitle),
  ];
  assert.deepEqual(
    rankCISBenchmarkCandidatesForTechnology(
      "IBM Db2 11",
      [db2v13, db2v11],
      excelFiles,
      "benchmark"
    ).candidates.map((candidate) => candidate.benchmark.workbenchId),
    [201],
    "a DB2 v11 tab must reject the DB2 v13 z/OS workbook"
  );
  assert.deepEqual(
    rankCISBenchmarkCandidatesForTechnology(
      "IBM Db2 13 for z/OS",
      [db2v11, db2v13],
      excelFiles,
      "benchmark"
    ).candidates.map((candidate) => candidate.benchmark.workbenchId),
    [202],
    "a DB2 v13 z/OS tab must reject the distributed DB2 v11 workbook"
  );
}

function assertMergedSourcesRemainSheetScoped() {
  const control = (
    sourceSheet: string,
    testId: string,
    recommendationNum: string
  ): SCSEMControlEvidence => ({
    id: `${sourceSheet}:${testId}`,
    sourceSheet,
    testId,
    nistId: "CM-6",
    nistControlName: "Configuration Settings",
    testMethod: "Examine",
    sectionTitle: "Configuration",
    description: `Existing ${recommendationNum}`,
    testProcedures: "Inspect the setting.",
    expectedResults: "The setting is secure.",
    criticality: "Moderate",
    cisBenchmarkRef: recommendationNum,
    recommendationNum,
    rationale: null,
    impact: null,
    remediationProcedure: null,
  });
  const recommendation = (id: string): CISBenchmarkRecommendation => ({
    profile: "Level 1",
    sourceSheet: "Level 1",
    sourceRow: 2,
    section: id,
    recommendation: id,
    title: `Recommendation ${id}`,
    assessmentStatus: "Manual",
    description: `Benchmark requirement ${id}`,
    rationale: null,
    impact: null,
    remediation: null,
    audit: `Audit ${id}`,
    additionalInfo: null,
    cisControls: null,
    references: null,
    defaultValue: null,
  });
  const controls = [
    control("Version A", "A-1", "1.1"),
    control("Version B", "B-1", "2.1"),
  ];
  const recommendations = [recommendation("1.1"), recommendation("2.1")];

  assert.equal(
    buildComparisonCandidates(controls, recommendations).newControlCandidates.length,
    0,
    "a union comparison masks recommendations missing from individual tabs"
  );
  const scoped = buildSheetScopedComparisonCandidates(
    controls,
    recommendations,
    ["Version A", "Version B"]
  );
  assert.deepEqual(
    scoped.map((comparison) => ({
      sheetName: comparison.sheetName,
      missing: comparison.newControlCandidates.map((candidate) => candidate.recommendation),
    })),
    [
      { sheetName: "Version A", missing: ["2.1"] },
      { sheetName: "Version B", missing: ["1.1"] },
    ]
  );
}

function assertVersionedDatabaseQueriesStayExact() {
  const oraclePath = path.join(process.cwd(), "data/scsems/current/safeguards-scsem-oracle.xlsx");
  const parsed = parseSCSEMFile(oraclePath);
  const oracle19Queries = scsemBenchmarkQueriesForSheet(
    "Oracle 19 RDBMS Test Cases",
    parsed.metadata.subject || "Oracle",
    parsed
  );
  assert.deepEqual(oracle19Queries, ["Oracle Database 19c"]);
  assert.equal(
    isExactCISProductIdentity("Oracle Database 19c", "CIS Oracle Database 12c Benchmark v4.0.0"),
    false
  );

  const sqlPath = path.join(process.cwd(), "data/scsems/current/safeguards-microsoft-sql-server-scem-v60-08252024.xlsx");
  const sqlParsed = parseSCSEMFile(sqlPath);
  const sql2022Queries = scsemBenchmarkQueriesForSheet(
    "SQL 2022 Test Cases",
    sqlParsed.metadata.subject || "Microsoft SQL Server",
    sqlParsed
  );
  assert.deepEqual(sql2022Queries, ["Microsoft SQL Server 2022"]);
  assert.equal(
    isExactCISProductIdentity(
      sql2022Queries[0],
      "CIS Microsoft SQL Server 2022 Benchmark v4.0.0"
    ),
    true
  );
}

function assertExactCurrentBenchmarkSurvivesRenumbering() {
  const renumberedProfile = {
    profile: "Level 1 - Member Server",
    recommendations: [{ recommendation: "9.9.1" }] as CISBenchmarkRecommendation[],
    sharedRecommendationCount: 0,
    totalRecommendationCount: 1,
  };
  assert.equal(
    isExactCISProductIdentity(
      "Oracle Database 12c",
      "CIS Oracle Database 12c Benchmark v4.0.0"
    ),
    true
  );
  assert.equal(
    isExactCISProductIdentity(
      "Oracle Database 12c",
      "CIS Oracle Database 19c Benchmark v2.0.0"
    ),
    false,
    "substring title similarity must not admit Oracle 19c for an Oracle 12c sheet"
  );
  assert.equal(
    isCISBenchmarkSelectionAccepted(renumberedProfile, 120, true),
    true,
    "an exact accepted product/generation benchmark must remain eligible when a new revision renumbers every recommendation"
  );
  assert.equal(
    isCISBenchmarkSelectionAccepted(renumberedProfile, 0, true),
    true,
    "an exact accepted product/generation benchmark must be eligible to propose the first CIS controls when the SCSEM has no recommendation IDs"
  );
  assert.equal(
    isCISBenchmarkSelectionAccepted(renumberedProfile, 0, false),
    false,
    "a sheet with no recommendation IDs must not use a non-exact benchmark identity"
  );
  assert.equal(
    isCISBenchmarkSelectionAccepted(renumberedProfile, 120, false),
    false,
    "a non-exact product identity still requires material recommendation overlap"
  );

  const failedAttempt = {
    kind: "CIS" as const,
    query: "Microsoft SQL Server 2022",
    sheetName: "SQL 2022 Test Cases",
    workbenchId: 10,
    benchmarkTitle: "CIS Microsoft SQL Server 2022 Benchmark",
    benchmarkVersion: "4.0.0",
    productFamily: "microsoft-sql-server",
    productGeneration: "2022",
    titleScore: 1000,
    outcome: "download_failed" as const,
    reason: "download failed",
  };
  assert.equal(hasUnavailableApplicableBenchmarkQuery([{
    kind: "CIS",
    query: failedAttempt.query,
    sheetName: failedAttempt.sheetName,
    catalogCandidates: [],
    candidateAttempts: [failedAttempt],
  }]), true);
  assert.equal(hasUnavailableApplicableBenchmarkQuery([{
    kind: "CIS",
    query: failedAttempt.query,
    sheetName: failedAttempt.sheetName,
    catalogCandidates: [],
    candidateAttempts: [{ ...failedAttempt, outcome: "parse_failed", reason: "no parseable recommendations" }],
  }]), true, "a schema/parse failure must fail closed just like a download failure");
  assert.equal(hasUnavailableApplicableBenchmarkQuery([{
    kind: "CIS",
    query: failedAttempt.query,
    sheetName: failedAttempt.sheetName,
    catalogCandidates: [],
    candidateAttempts: [failedAttempt, { ...failedAttempt, outcome: "accepted", reason: "accepted" }],
  }]), false, "an accepted fallback candidate resolves the query-level availability blocker");
}

async function main() {
  assertVersionedDatabaseQueriesStayExact();
  assertExactCurrentBenchmarkSurvivesRenumbering();
  assertDb2VersionTabsStayIndependent();
  assertMergedSourcesRemainSheetScoped();
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
  const archived = benchmark(
    106,
    "CIS Microsoft Windows Server 2022 Benchmark v8.0.0",
    "Accepted",
    "8.0.0"
  );
  archived.workbenchStatus = { status: "archived" };
  const benchmarks = [draft, accepted, missingStatus, crossGeneration, cisStig, archived];
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
  assert.match(
    normal.diagnostics.find((candidate) => candidate.workbenchId === 106)?.rejectionReasons.join(" ") || "",
    /WorkBench status is archived/
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
