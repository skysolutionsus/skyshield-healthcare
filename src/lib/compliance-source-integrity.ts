import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectPub1075Version } from "@/lib/knowledge/ingest";

const MANIFEST_PATH = "data/compliance-source-manifest.json";
const PUB1075_TEXT_PATH = "data/pub1075/p1075-full-text.md";
const PUB1075_PUBLICATION_PATH = "data/pub1075/p1075.pdf";
const NIST_SNAPSHOT_PATH = "data/nist/sp800-53-rev5-controls.json";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

type PinnedFile = {
  path: string;
  size: number;
  sha256: string;
};

export type ComplianceSourceManifest = {
  schemaVersion: 1;
  reviewedAt: string;
  pub1075: {
    version: string;
    text: PinnedFile;
    publication: PinnedFile;
  };
  nist: PinnedFile & {
    version: string;
    sourceCommit: string;
    sourceUrl: string;
    sourceSha256: string;
  };
};

type NistSnapshotIdentity = {
  version?: unknown;
  sourceCommit?: unknown;
  sourceUrl?: unknown;
  sourceSha256?: unknown;
};

export class ComplianceSourceIntegrityError extends Error {
  readonly code = "COMPLIANCE_SOURCE_INTEGRITY_FAILED";

  constructor() {
    super("Pinned compliance source integrity verification failed.");
    this.name = "ComplianceSourceIntegrityError";
  }
}

function fail(): never {
  throw new ComplianceSourceIntegrityError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPinnedFile(value: unknown, expectedPath: string): value is PinnedFile {
  if (!isRecord(value)) return false;
  return (
    value.path === expectedPath &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) > 0 &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256)
  );
}

function parseManifest(raw: string): ComplianceSourceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail();
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== 1) fail();
  const pub1075 = parsed.pub1075;
  const nist = parsed.nist;
  if (!isRecord(pub1075) || !isRecord(nist)) fail();
  const nistVersion = nist.version;
  const nistSourceCommit = nist.sourceCommit;
  const nistSourceUrl = nist.sourceUrl;
  const nistSourceSha256 = nist.sourceSha256;
  if (
    typeof parsed.reviewedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed.reviewedAt) ||
    typeof pub1075.version !== "string" ||
    !isPinnedFile(pub1075.text, PUB1075_TEXT_PATH) ||
    !isPinnedFile(pub1075.publication, PUB1075_PUBLICATION_PATH) ||
    !isPinnedFile(nist, NIST_SNAPSHOT_PATH) ||
    typeof nistVersion !== "string" ||
    typeof nistSourceCommit !== "string" ||
    !COMMIT_PATTERN.test(nistSourceCommit) ||
    typeof nistSourceUrl !== "string" ||
    !nistSourceUrl.includes(nistSourceCommit) ||
    typeof nistSourceSha256 !== "string" ||
    !SHA256_PATTERN.test(nistSourceSha256)
  ) {
    fail();
  }

  return parsed as ComplianceSourceManifest;
}

function readPinnedFile(rootDir: string, pinned: PinnedFile): Buffer {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(rootDir, pinned.path));
  } catch {
    fail();
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== pinned.size || actualSha256 !== pinned.sha256) fail();
  return bytes;
}

/**
 * Verify the exact reviewed Pub 1075 and NIST snapshots before they can govern
 * an analysis. The manifest is intentionally separate from the evidence files
 * so source updates require an explicit, reviewable digest change.
 */
export function verifyComplianceSourceIntegrity(
  rootDir = process.cwd()
): ComplianceSourceManifest {
  let manifestRaw: string;
  try {
    manifestRaw = fs.readFileSync(path.join(rootDir, MANIFEST_PATH), "utf8");
  } catch {
    fail();
  }

  const manifest = parseManifest(manifestRaw);
  const pubText = readPinnedFile(rootDir, manifest.pub1075.text).toString("utf8");
  readPinnedFile(rootDir, manifest.pub1075.publication);
  const nistText = readPinnedFile(rootDir, manifest.nist).toString("utf8");

  if (detectPub1075Version(pubText) !== manifest.pub1075.version) fail();

  let nistIdentity: NistSnapshotIdentity;
  try {
    nistIdentity = JSON.parse(nistText) as NistSnapshotIdentity;
  } catch {
    fail();
  }
  if (
    nistIdentity.version !== manifest.nist.version ||
    nistIdentity.sourceCommit !== manifest.nist.sourceCommit ||
    nistIdentity.sourceUrl !== manifest.nist.sourceUrl ||
    nistIdentity.sourceSha256 !== manifest.nist.sourceSha256
  ) {
    fail();
  }

  return manifest;
}
