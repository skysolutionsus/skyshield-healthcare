import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";
import type { SCSEMUpdaterSession } from "../src/lib/scsem-updater-store";

// Actual bootstrap, filesystem persistence, integrity, review and export handlers.
// Only auth, licensed network inputs and durable audit database are substituted.
function loadRoute(file: string, dependencies: Record<string, unknown>) {
    const exports: Record<string, (...args: unknown[]) => Promise<Response>> = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, require: (name: string) => {
        if (!(name in dependencies)) throw new Error(`Unprovided dependency ${name}`);
        return dependencies[name];
    }, console: { ...console, error: () => {} }, Request, Response, URL, Buffer, Map, Set });
    return exports;
}
async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scsem-bootstrap-integrity-"));
    const previousRoot = process.env.SKYSHIELD_RUNTIME_DATA_DIR;
    process.env.SKYSHIELD_RUNTIME_DATA_DIR = root;
    try {
        const store = await import("../src/lib/scsem-updater-store");
        const integrity = await import("../src/lib/scsem-source-integrity");
        const auditEvents: unknown[] = [];
        const harness = store.createSCSEMUpdaterDurabilityTestHarness({
            persistIntent: async (event) => { auditEvents.push(event); },
            persistOutcome: async (event) => { auditEvents.push(event); },
        });
        const user = { id: "synthetic-reviewer", organizationId: "synthetic-org" };
        const benchmark = { workbenchId: 1234, benchmarkTitle: "CIS SYNTHETIC Benchmark", benchmarkVersion: "TEST", benchmarkStatus: { status: "accepted" }, workbenchStatus: { status: "published" } };
        const dependencies: Record<string, unknown> = {
            "next/server": { NextResponse: Response },
            "@/lib/audit": { auditRequestContext: () => ({}), createAuditOperationId: () => "synthetic-export", logAuditStrict: async (event: unknown) => { auditEvents.push(event); } },
            "@/lib/cis-api": { getCISToken: async () => "synthetic", fetchAllBenchmarks: async () => [benchmark], fetchAllBenchmarkExcelFiles: async () => [benchmark] },
            "@/lib/scsem-update-engine": { downloadAndParseBenchmark: async () => ({
                snapshot: { ...benchmark, releaseDate: new Date("2026-01-01"), downloadedAt: new Date("2026-01-01"), sha256: "a".repeat(64), filePath: "SYNTHETIC", excelTitle: "SYNTHETIC", excelFileName: "SYNTHETIC.xlsx" },
                recommendations: [{ profile: "SYNTHETIC", recommendation: "1.1", title: "Synthetic setting", section: "1", description: "Synthetic only", audit: "Inspect synthetic setting", remediation: "Enable synthetic setting.", sourceSheet: "SYNTHETIC", sourceRow: 42 }],
            }) },
            "@/lib/scsem-updater-store": { ...store, createSCSEMUpdaterSession: harness.createSession, writeSCSEMUpdaterSession: harness.writeSession },
            "@/lib/scsem-steward-auth": { requireScsemSteward: async () => ({ ok: true, user }) },
        };
        for (const name of ["scsem-cis-bootstrap", "scsem-updater-client-session", "scsem-benchmark-failure", "scsem-generator-evidence", "scsem-proposal-validation", "scsem-updater-route-failure", "scsem-issue-codes", "scsem-source-integrity", "scsem-change-audit", "scsem-source-precedence", "scsem-new-control-schema", "xlsx-parser", "scsem-workbook-export", "scsem-export-error"]) {
            dependencies[`@/lib/${name}`] = await import(`../src/lib/${name}`);
        }
        const bootstrap = loadRoute("src/app/api/scsem-updater/bootstrap/route.ts", dependencies);
        const result = await bootstrap.POST(new Request("http://localhost/bootstrap", { method: "POST", body: JSON.stringify({ workbenchId: 1234, profile: "SYNTHETIC" }) }));
        assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
        const id = (await result.json()).session.id;
        let session = store.readSCSEMUpdaterSessionForUser(id, user);
        assert.equal(session.workspaceMode, "cis_bootstrap");
        assert.equal(session.changes.length, 1);
        assert.ok(auditEvents.length > 0);
        const review = loadRoute("src/app/api/scsem-updater/[id]/changes/route.ts", dependencies);
        const exporter = loadRoute("src/app/api/scsem-updater/[id]/export/route.ts", dependencies);
        const reviewRequest = () => review.PATCH(new Request("http://localhost/changes", {
            method: "PATCH", headers: { "If-Match": store.scsemUpdaterRevisionETag(session) },
            body: JSON.stringify({ changeId: session.changes[0].id, status: "APPROVED" }),
        }), { params: Promise.resolve({ id }) });
        const reviewed = await reviewRequest();
        const reviewBody = await reviewed.json();
        assert.notEqual(reviewBody.code, "SCSEM_SOURCE_INTEGRITY_FAILURE", "untouched persisted bootstrap must reach reviewer evidence gates, not fail source integrity");
        assert.equal(reviewed.status, 400, "unresolved synthetic candidate must still be denied approval");
        assert.equal(store.readSCSEMUpdaterSession(id).revision, session.revision);
        const verified = integrity.assertSCSEMUpdaterSourceIntegrity(session);
        assert.equal(verified.sourceTrust, "cis_bootstrap_draft");
        assert.equal(verified.officialSource, undefined, "derived shell is never an official IRS workbook");
        console.log("PASS: real bootstrap -> persisted store -> review reaches evidence gate; derived trust is explicit");
        const exportRequest = () => exporter.GET(new Request("http://localhost/export?draft=1", { headers: { "If-Match": store.scsemUpdaterRevisionETag(session) } }), { params: Promise.resolve({ id }) });
        const exported = await exportRequest();
        assert.equal(exported.status, 409);
        assert.match((await exported.json()).error, /still pending/);
        console.log("PASS: real export integrity accepts untouched shell while pending-review gate remains closed");
        const reject = (candidate: SCSEMUpdaterSession) => assert.throws(() => integrity.assertSCSEMUpdaterSourceIntegrity(candidate), integrity.SCSEMSourceIntegrityError);
        reject({ ...session, workspaceMode: "official_update" });
        reject({ ...session, workspaceMode: "unverified_update" });
        reject({ ...session, audit: { ...session.audit, cisBootstrap: undefined } });
        for (const [key, value] of Object.entries({ sourceFileName: "forged.xlsx", sourceUrl: "https://invalid.example", sourceSha256: "0".repeat(64), sourceVersion: "forged", targetSheet: "forged" })) {
            const candidate = structuredClone(session);
            Object.assign(candidate.audit.cisBootstrap!.structuralBaseline, { [key]: value });
            reject(candidate);
        }
        reject({ ...session, audit: { ...session.audit, uploadedSha256: "0".repeat(64) } });
        reject({ ...session, audit: { ...session.audit, uploadedSizeBytes: 0 } });
        const source = fs.readFileSync(verified.absolutePath);
        fs.appendFileSync(verified.absolutePath, Buffer.from("tampered"));
        reject(session);
        assert.equal((await (await reviewRequest()).json()).code, "SCSEM_SOURCE_INTEGRITY_FAILURE");
        assert.equal((await (await exportRequest()).json()).code, "SCSEM_SOURCE_INTEGRITY_FAILURE");
        fs.writeFileSync(verified.absolutePath, source);
        fs.unlinkSync(verified.absolutePath);
        reject(session);
        console.log("PASS: missing/tampered bytes, hash/size drift, forged baseline and ordinary updater relabeling fail closed");
        fs.writeFileSync(verified.absolutePath, source);
        const { readSCSEMIssueCodeCatalog } = await import("../src/lib/scsem-issue-codes");
        const { resolveGeneratorPolicyEvidence } = await import("../src/lib/scsem-generator-evidence");
        const issueCode = [...readSCSEMIssueCodeCatalog(verified.absolutePath).keys()][0];
        const originalEvidence = structuredClone(session.changes[0].sourceEvidence);
        const approved = await review.PATCH(new Request("http://localhost/changes", {
            method: "PATCH", headers: { "If-Match": store.scsemUpdaterRevisionETag(session) },
            body: JSON.stringify({ changeId: session.changes[0].id, status: "APPROVED",
                change: { newControl: { nistId: "CM-6", criticality: "Moderate", issueCode, expectedResults: "Synthetic setting is enabled." } },
                reviewerEvidence: { expectedResultsSourceQuote: "Enable synthetic setting.", expectedResultsRationale: "Synthetic test fixture: enabled is the pass condition.", applicabilityRationale: "Synthetic test fixture only, not a real CIS applicability determination.", policyEvidenceSha256: resolveGeneratorPolicyEvidence("CM-6").sha256 },
            }),
        }), { params: Promise.resolve({ id }) });
        assert.equal(approved.status, 200, JSON.stringify(await approved.clone().json()));
        session = store.readSCSEMUpdaterSessionForUser(id, user);
        assert.equal(session.changes[0].status, "APPROVED");
        assert.equal(session.status, "analysis_incomplete");
        assert.deepEqual(session.changes[0].sourceEvidence, originalEvidence);
        const download = await exportRequest();
        assert.equal(download.status, 200);
        assert.match(download.headers.get("Content-Disposition") || "", /DRAFT-INCOMPLETE/);
        const XLSX = await import("xlsx");
        const candidate = XLSX.read(Buffer.from(await download.arrayBuffer()), { type: "buffer" });
        const cells = Object.values(candidate.Sheets["General App Test Cases"]);
        assert.ok(cells.some((cell) => typeof cell === "object" && cell?.v === "Synthetic setting is enabled."));
        assert.equal(integrity.sha256Hex(fs.readFileSync(verified.absolutePath)), session.audit.uploadedSha256);
        console.log("PASS: real reviewer approval persists unchanged source evidence; real draft export contains approved synthetic control and leaves source bytes intact");
    } finally {
        if (previousRoot === undefined) delete process.env.SKYSHIELD_RUNTIME_DATA_DIR;
        else process.env.SKYSHIELD_RUNTIME_DATA_DIR = previousRoot;
        fs.rmSync(root, { recursive: true, force: true });
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
