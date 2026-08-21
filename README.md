# IRS SkyShield

IRS SkyShield is an internal IRS Office of Safeguards workspace for Publication 1075 research, canonical SCSEM template stewardship, security incident handling, and auditable AI-assisted analysis.

The SCSEM Updater is for authorized Office of Safeguards personnel who maintain the canonical templates that agencies may later use as guidance. It is not an agency control-submission, assessment, attestation, or compliance-certification system. Automation can draft evidence-backed changes, but an authorized reviewer must approve every candidate change and a separately governed release process must approve publication.

## Core Capabilities

- AI Compliance Agent: Ask questions about Publication 1075 and related guidance with retrieved source context, citations, and audit metadata.
- SCSEM Updater: Start from a pinned, hash-identified IRS Safeguards SCSEM source; choose a Publication 1075/NIST-only or full CIS WorkBench review; compare every version/provider tab independently; and export a reviewer-approved candidate XLSX.
- CIS Bootstrap Drafts: Start a new, explicitly non-official SCSEM working draft from an accepted licensed CIS WorkBench Excel artifact and exact profile. SkyShield uses the pinned Generic Application SCSEM only as a controlled blank structural shell; every generated control remains reviewer-gated and requires Publication 1075/NIST mapping, IRS issue-code selection, applicability review, and separate release approval.
- Workbook Fidelity: Candidate exports preserve the canonical workbook's structure and formulas while limiting edits to approved template-content fields. Agency-entered responses, evidence, observed findings, remediation, status, and risk values are never imported or carried forward by this workflow; template-owned standard finding text is canonical control metadata.
- Audit Log Drilldowns: Audit entries are clickable and show structured details such as input, output, retrieval context, action metadata, and raw JSON.
- Incident Tracking: Capture, triage, and document incidents including PII/FTI detection events from the agent.
- Knowledge Base: Ingest Publication 1075, IRS interim guidance, and other supporting documents for hybrid search and retrieval.
- MFA and RBAC: Credential auth, mandatory TOTP enrollment, recovery codes, role-gated navigation, and admin account recovery.
- Deployment Ready: Dockerized Next.js app with PostgreSQL, pgvector, Prisma migrations, runtime upload storage, and a health endpoint.

## Product Model

SkyShield has three important operating principles:

1. Source material is pinned and auditable.
   The accepted IRS SCSEM set, Publication 1075 source, NIST snapshot, and any licensed CIS Benchmark or CIS-published STIG profile workbooks are identified by source URL or CIS WorkBench ID, version/release metadata, retrieval time, and file hash. Uploaded files, source snapshots, match diagnostics, and generated decisions are retained so a reviewer can reconstruct exactly what was used.

2. Human review remains mandatory.
   The app can identify likely updates, stricter requirements, missing controls, and conflicts among SCSEM, CIS Benchmark, CIS-STIG, Publication 1075, and NIST sources. It does not make a final applicability decision or silently rewrite a release. Reviewers approve, reject, edit, undo, and document source gaps.

3. An export is a candidate draft, not a release.
   Approval in SkyShield authorizes a proposal for the candidate workbook only. It does not publish a canonical SCSEM, certify compliance, or replace Office of Safeguards quality-control, legal/policy, licensing, accessibility, and release approvals.

## Technology Stack

| Layer | Implementation |
| --- | --- |
| Web app | Next.js 16 App Router, React 19 |
| UI | Tailwind CSS v4, local components, lucide-react icons |
| Database | PostgreSQL 16, Prisma ORM, pgvector |
| Auth | NextAuth v5 credentials provider, JWT sessions, TOTP MFA |
| AI | Bifrost chat completions and embeddings |
| Spreadsheets | `xlsx` for parsing, `xlsx-populate` for format-preserving workbook edits |
| Deployment | Docker, docker-compose, standalone Next output |

## Architecture Layers

SkyShield is currently a full-stack Next.js application. The browser UI is JavaScript/TypeScript rendered by React and Next.js. The backend API is also TypeScript running in the Next.js Node.js runtime. Python is used for local utility scripts and document/PDF generation, not as a production API service.

```mermaid
flowchart LR
  User["Authorized IRS steward"] --> UI["React / Next.js UI\n/scsems, /agent, /audit-log"]
  UI --> API["Next.js API routes\nNode.js runtime"]
  API --> Auth["Auth layer\nNextAuth, MFA, RBAC"]
  API --> Services["Domain services\nSCSEM parser, update engine,\nknowledge retrieval, CIS WorkBench client"]
  Services --> Storage["Runtime file storage\nuploads, exports, benchmark snapshots"]
  Services --> DB["PostgreSQL + Prisma\nusers, audit logs, incidents,\nknowledge chunks, settings"]
  Services --> AI["Bifrost AI APIs\noptional recommendations and embeddings"]
  Services --> CIS["Licensed CIS WorkBench\nCIS Benchmark and CIS-STIG workbooks"]
```

Cross-cutting security controls sit across the API and service layers: mandatory MFA, Office of Safeguards steward authorization, creator- and organization-scoped updater sessions, upload size/type/signature/hash validation, PII/FTI blocking before AI calls, audit logging, pinned source hashes, and HTTP security headers.

## SCSEM Update Workflow

```mermaid
flowchart LR
  Upload["Select official IRS SCSEM source"] --> Pin["Verify pinned manifest entry\nand SHA-256 hash"]
  Pin --> Parse["Parse workbook\ninfer technology and controls"]
  Parse --> Standards["Compare pinned Pub 1075\nand NIST source snapshots"]
  Standards --> Match["Evaluate licensed CIS Benchmark/CIS-STIG\nversion, profile, and applicability"]
  Match --> Propose["Generate candidate template changes\nwith source gaps made explicit"]
  Propose --> Review["Authorized reviewer\napprove, reject, edit, undo"]
  Review --> Export["Export candidate XLSX\napproved changes only"]
  Export --> Release["Separate Office of Safeguards\nQC and release approval"]
```

Primary API calls for the stewardship flow:

- `POST /api/scsem-updater/upload` validates the workbook against the pinned IRS source manifest, stores it, parses metadata, creates a steward-scoped updater session, and logs the upload.
- `POST /api/scsem-updater/[id]/analyze` accepts `analysisScope: "compliance_only" | "full"`. Compliance-only scope reviews existing mapped rows against Publication 1075, using NIST as mapping and assessment evidence without turning unmatched document sections into new technology test cases. Full scope requires licensed CIS WorkBench access, evaluates CIS Benchmark, CIS-STIG, public DISA STIG, and Publication 1075 lanes independently, and preserves the strictest applicable control or an explicit reviewer conflict when strictness is ambiguous. Version/provider tabs keep exact sheet identity throughout batching, matching, review, and export.
- `POST /api/scsem-updater/bootstrap` accepts an explicit numeric CIS WorkBench ID and exact profile, downloads and snapshots the licensed accepted benchmark Excel artifact, and creates a blank non-official working draft with source-bound candidate controls.
- `PATCH /api/scsem-updater/[id]/changes` records reviewer edits, approvals, rejections, and batch decisions.
- `POST /api/scsem-updater/[id]/undo` restores the most recent approve/reject action.
- `GET /api/scsem-updater/[id]/export` applies reviewer-approved template changes and returns a candidate XLSX; it does not publish an official release.

Updater session responses include a numeric `revision` and matching `ETag`. Every analyze, change-review, and undo mutation must send that ETag in `If-Match`. Session writes use an atomic same-directory replace and a short-lived per-session lock; stale clients receive HTTP 409 and must reload instead of overwriting newer review work.

## Main Workflows

### AI Compliance Agent

The agent route is `/agent`.

1. A signed-in user submits a compliance question.
2. The server scans the prompt for FTI/PII patterns before any AI call.
3. If sensitive data is detected, the message is blocked, an incident is created, and the action is logged.
4. If the prompt is allowed, the app searches the knowledge base using exact control matching, title matching, keyword search, cross-reference expansion, and vector retrieval when embeddings are configured.
5. The selected context is sent to Bifrost.
6. The response, citations, retrieval metadata, input, output, model, and demo-mode status are written to the audit log.

Without a configured Bifrost key, the app can still return demo responses and run deterministic parts of the system.

### SCSEM Updater

The SCSEM Updater route is `/scsems`. The navigation label is "SCSEM Updater".

This page replaces the old static SCSEM browser as the internal canonical-template stewardship workflow. Agencies do not submit system implementations, evidence, findings, or control status here.

1. An authorized Office of Safeguards steward selects an IRS SCSEM workbook named like `Safeguards-SCSEM (Technology).xlsx`.
2. The server verifies the workbook against the pinned official-source manifest, records its SHA-256 hash and provenance, stores it under runtime storage, and creates a creator- and steward-organization-scoped updater session. The August 20, 2026 snapshot pins all 60 individual XLSX links on the IRS page. The separately linked 62-workbook package ZIP is audited but not treated as interchangeable canonical bytes because all 59 subject/version pairs differ at the raw-file level, it includes three package-only templates, and it omits the individually listed Windows Server 2012 template. A new or program-supplied workbook whose hash is not yet pinned may proceed only when it has recognizable SCSEM test-case schemas, controls, an Issue Code Table, and no populated actual-result/status responses. It is visibly and permanently gated as an unverified incomplete working draft until an authorized reviewer verifies provenance and release status.
3. The workbook is parsed to identify sheets, test-case rows, headers, template-content fields, NIST IDs, CIS references, recommendation numbers, formulas, and existing release/change-log sheets.
4. The app infers the target technology from workbook content before using subject metadata or the filename. A multi-provider Cloud workbook stays multi-provider instead of being collapsed to the first AWS/Azure/Google signal.
5. The app resolves the workbook to the corresponding pinned entry in the current IRS SCSEM source set and records whether a newer official structural baseline is required for candidate drafting.
6. The pinned Publication 1075 source supplies binding policy evidence for mapped controls. The pinned NIST SP 800-53 Rev. 5 and 800-53A snapshots supply control mapping and assessment evidence; they do not independently create technology-specific test cases. In full scope, SkyShield compares directly applicable CIS Benchmark, CIS-STIG, public DISA STIG, and Publication 1075 evidence and retains the strictest applicable requirement.
7. The reviewer chooses either Publication 1075/NIST-mapping-only scope or full strictest-control scope. Compliance-only scope never authenticates to CIS WorkBench and does not require SecureSuite credentials. Full scope fails closed before analysis unless an authorized SecureSuite license is configured, then calls `POST /license`, `GET /benchmarks`, and `GET /excel`, followed by `GET /excel/{workbenchId}` for candidates. Catalog matching is local; license access and title similarity do not establish applicability.
8. CIS Benchmark and CIS-STIG candidates are checked per test-case tab for product family, product generation, benchmark revision, profile, sheet scope, and recommendation evidence. DB2 v11 and DB2 v13 for z/OS remain separate queries and cannot fall back to a broad DB2 query that competes across generations. Cross-major matches such as RHEL 8 to RHEL 9 or ESXi 7 to ESXi 8 are rejected. An exact accepted product/generation match remains eligible when a new benchmark renumbers controls, because those changes are precisely what the updater must surface for review. An authorized reviewer must still confirm applicability and permitted use of licensed material.
9. Downloaded benchmark artifacts are stored as audit snapshots with source kind, title, version, release date, filename, workbench/source ID, local path, retrieval time, and SHA-256 hash.
10. The comparison engine creates reviewer-gated candidate changes. Publication 1075, directly applicable CIS Benchmark/CIS-STIG workbooks, and pinned public DISA STIG packages are independent authorities. When they propose different values for one cell, SkyShield either selects the clearly stricter applicable control or preserves a mutually exclusive conflict group for explicit reviewer selection; NIST remains mapping and assessment evidence.
11. Missing AI configuration, timeouts, malformed output, unavailable licenses, unmatched benchmarks, or unresolved CIS-STIG applicability are recorded as incomplete source coverage. Deterministic suggestions may still be shown, but the session must not be described as a complete review or release-ready result.
12. The UI shows source versions and hashes, content-identification signals, exact target sheet/cell intent, baseline decision, benchmark query/overlap diagnostics, unresolved conditions, and current/proposed values.
13. Reviewers approve, reject, edit, batch review, and undo proposals. Revision preconditions prevent a stale browser tab from overwriting newer review work. Approval means "include in this candidate draft"; it is not publication approval.
14. Export produces a candidate XLSX for separate Office of Safeguards quality control and release approval.

#### SCSEM Update Fields

The update engine intentionally limits cell updates to fields that map to control content and review language:

- `testProcedures`
- `expectedResults`
- `remediationProcedure`
- `description`
- `rationale`
- `impact`
- `sectionTitle`
- `findingStatement`

New controls can be proposed when a CIS Benchmark or CIS-STIG recommendation appears applicable and is not already represented in the canonical source. They are never appended without explicit reviewer approval, and the reviewer must confirm technology/profile applicability, source authority, licensing constraints, and an exact canonical issue-code mapping from the uploaded workbook's `Issue Code Table`. Automation does not invent that risk mapping.

#### Workbook Export Behavior

Export uses the hash-validated IRS workbook, its newer pinned official structural baseline, or the admitted unverified workbook itself as the base file. An unverified source remains analysis-incomplete regardless of otherwise successful comparisons. Every result is a candidate draft.

- Existing reviewer-approved template-content updates are written into the matching test-case row and column.
- Reviewer-approved updates and new controls are routed to the exact matched version/provider sheet, with copied row formatting for appended rows.
- Agency-entered assessment/response values—including actual result, implementation status, notes/evidence, and agency remediation/CAP text—are outside this product's SCSEM workflow and are never imported, inferred, or carried forward.
- Template-owned standard finding text, criticality, issue-code mapping, and risk-rating formulas are canonical control metadata. Where the selected sheet has a unique Finding Statement column, a new control must include reviewer-approved standard finding text; layouts without that physical column remain structurally unchanged. Every new control must receive an exact reviewer-selected code from that workbook's `Issue Code Table`; its mapping description and formula are then preserved or constructed from the verified template schema rather than copied as response data from another control.
- Existing workbook styles, filters, colors, widths, sheet names, and workbook structure are preserved by editing the original XLSX package rather than regenerating a workbook from scratch.
- If no changes have been approved and no official structural upgrade was selected, export returns the original workbook bytes.
- If the workbook includes `Change Log` or `New Release Changes` sheets, export may append traceable candidate-draft entries for approved changes. Those entries do not assign an official release date or publication status.

The output is designed to remain visually and structurally equivalent to its pinned base, with only reviewer-approved template changes applied. It must be inspected in Microsoft Excel and pass separate Office of Safeguards release controls before publication. Export does not certify an agency, a technology, the workbook's completeness, or compliance with Publication 1075, NIST, CIS, or any STIG.

#### Matching Notes

Not every IRS SCSEM has a one-to-one CIS Benchmark or CIS-STIG workbook in CIS WorkBench. The IRS Cloud SCSEM, for example, contains an `AWS Foundations` tab, while Amazon Linux 2023 is a separate SCSEM. Matching therefore uses workbook content and per-sheet product/version identities, not filename equality. The UI reports the local query, attempted candidates, and rejection reason. A source miss remains an explicit unresolved condition; it does not become a claim that review is complete merely because other source comparisons ran.

SkyShield currently does not independently ingest, reconcile, or validate the authoritative DISA STIG library or DISA release history. A CIS-STIG workbook retrieved from CIS WorkBench must not be described as independently DISA-validated; any DISA source/version determination remains a required external reviewer step.

### Audit Log

The audit log route is `/audit-log`.

Rows are clickable. The detail drawer shows:

- Overview: action, resource, actor, IP address, user agent, and timestamp.
- Input: prompt text, uploaded file details, review action, or request metadata when available.
- Output: AI answer, proposed change counts, export information, or action result when available.
- Retrieval: selected knowledge documents, citations, controls, and search metadata for AI-agent activity.
- Raw Metadata: the persisted JSON payload.

Important logged actions include:

- `AI_QUERY`
- `PII_DETECTED`
- `SCSEM_UPDATER_UPLOAD`
- `SCSEM_UPDATER_ANALYZE`
- `SCSEM_UPDATER_REVIEW`
- `SCSEM_UPDATER_EDIT`
- `SCSEM_UPDATER_UNDO`
- `SCSEM_UPDATER_EXPORT`
- `USER_PASSWORD_RESET`
- `USER_MFA_RESET`
- `LLM_SETTINGS_UPDATED`

Audit logging is designed to be non-blocking for the main workflow. If an audit write fails, the user action should still complete, but the failure should be investigated.

### Incidents

Incident routes are `/incidents` and `/incidents/[id]`.

The incident system supports:

- Manual incident creation.
- Automatic incident creation when the AI agent detects FTI/PII in a prompt.
- Severity, status, assignee, due date, affected records, and remediation tracking.
- Activity timeline entries.
- False-positive reporting and review support.

### Knowledge Base

Admin users can manage knowledge sources at `/knowledge`.

Supported ingestion paths include:

- Official Publication 1075 sync from IRS.gov through `npm run rag:sync:pub1075`.
- Local Publication 1075 ingestion from `data/pub1075/p1075-full-text.md`.
- Bundled IRS interim guidance ingestion.
- Admin uploads for PDF, TXT, Markdown, and CSV sources.

Retrieval combines:

- Exact Publication 1075 section/control matching.
- Document title matching.
- Keyword and PostgreSQL full-text search.
- Query expansion and cross-reference handling.
- pgvector similarity search when embeddings are configured.
- Optional reranking when the configured AI stack supports it.

## Application Routes

| Route | Purpose |
| --- | --- |
| `/login` | Sign in with credentials |
| `/dashboard` | Internal operations overview, activity, incidents, and quick links |
| `/agent` | AI compliance assistant |
| `/scsems` | Authorized canonical-SCSEM source verification, candidate drafting, review, undo, and export |
| `/scsems/[id]` | Retired legacy detail URL; permanently redirects to the authoritative `/scsems` updater |
| `/incidents` | Incident list and filters |
| `/incidents/[id]` | Incident detail, timeline, and remediation |
| `/audit-log` | Searchable audit log with detail drawer |
| `/knowledge` | Admin knowledge-source management |
| `/settings` | MFA, user management, LLM settings, and view-as controls |
| `/settings/false-positives` | False-positive review |
| `/presentation` | Presentation/demo route |

## API Surface

| Endpoint | Methods | Purpose |
| --- | --- | --- |
| `/api/health` | GET | Minimal public readiness status; no configuration, URLs, counts, or internal diagnostics |
| `/api/auth/[...nextauth]` | GET, POST | NextAuth routes |
| `/api/mfa` | GET, POST | TOTP setup, verification, disable, and recovery-code rotation |
| `/api/chat` | GET, POST, PATCH | Conversations, agent messages, and bookmarks |
| `/api/dashboard` | GET | Organization-scoped operational metrics and steward-only pinned SCSEM source-manifest facts |
| `/api/audit-log` | GET | Paginated audit log data |
| `/api/incidents` | GET, POST | Incident listing and creation |
| `/api/incidents/[id]` | GET, PUT | Incident detail and updates |
| `/api/incidents/[id]/false-positive` | POST | Mark incident as false positive |
| `/api/false-positives` | GET, POST | False-positive list and review |
| `/api/users` | GET, POST | Admin user management, invites, password reset, MFA reset |
| `/api/settings/llm` | GET, PUT | Admin LLM model/key settings |
| `/api/settings/view-as` | GET, POST, DELETE | Admin view-as support |
| `/api/admin/knowledge` | GET, POST | Admin knowledge source list and upload |
| `/api/admin/knowledge/[id]` | GET, DELETE | Knowledge document detail and delete |
| `/api/admin/knowledge/search` | POST | Admin knowledge search testing |
| `/api/scsem-updater/upload` | POST | Upload SCSEM workbook and create updater session |
| `/api/scsem-updater/bootstrap` | POST | Create a blank, non-official SCSEM working draft from an explicit accepted CIS WorkBench ID and profile |
| `/api/scsem-updater/[id]` | GET | Load updater session |
| `/api/scsem-updater/[id]/analyze` | POST | Generate source-attributed candidate template changes and unresolved-source diagnostics |
| `/api/scsem-updater/[id]/changes` | PATCH | Approve, reject, edit, or batch-review proposed changes |
| `/api/scsem-updater/[id]/undo` | POST | Undo last review action |
| `/api/scsem-updater/[id]/export` | GET | Export approved changes as a candidate XLSX (not an official release) |
| `/api/scsems/[id]` | GET | Retired legacy SCSEM detail API (HTTP 410) |
| `/api/scsems/[id]/export` | GET | Legacy SCSEM export |
| `/api/scsems/[id]/review` | POST | Retired legacy mutation (HTTP 410) |
| `/api/scsems/sync` | POST | Retired legacy benchmark sync (HTTP 410) |
| `/api/scsems/sync-pub1075` | POST | Retired legacy review generator (HTTP 410) |
| `/api/scsems/update-pub1075` | GET, POST | Read pinned status; live replacement retired (POST HTTP 410) |
| `/api/test-ai` | GET | AI connectivity test |

## Data and Storage

### Repository Data

| Path | Purpose |
| --- | --- |
| `data/pub1075/p1075.pdf` | Bundled Publication 1075 PDF |
| `data/pub1075/p1075-full-text.md` | Extracted Publication 1075 text used by SCSEM analysis and fallback context |
| `data/scsem-index.json` | Metadata for bundled IRS SCSEM templates |
| `data/scsem-manifest.json` | Pinned official IRS SCSEM source URLs, filenames, versions, retrieval metadata, and SHA-256 hashes |
| `data/scsems/current/` | Flat, hash-pinned corpus of all 60 current individual IRS SCSEM workbooks |
| `public/` | Static assets and bundled interim guidance text |

CIS SecureSuite credentials and license material are operational secrets and must be provisioned outside source control using the deployment's approved secret-management process. Access to a licensed artifact does not establish its applicability to an SCSEM; the authorized reviewer must document that determination.

### Runtime Storage

Runtime-generated files are written through `src/lib/runtime-storage.ts`.

Resolution order:

1. `SKYSHIELD_RUNTIME_DATA_DIR`, when configured and writable.
2. `<repo>/data`, when writable in local development.
3. OS temp directory under `skyshield-data`.

Docker sets:

```env
SKYSHIELD_RUNTIME_DATA_DIR=/var/lib/skyshield
```

The docker-compose file mounts this path as the `skyshield_runtime_data` volume. SCSEM uploads, updater sessions, exported workbook working data, and downloaded CIS Benchmark/CIS-STIG snapshots should use runtime storage rather than the application bundle.

## Database

The app uses Prisma with PostgreSQL. Major model groups include:

- Organization and User.
- MFA recovery codes and authentication state.
- Conversations and Messages.
- SCSEM templates, sheets, controls, change logs, and review records.
- SCSEM updater sessions stored as runtime JSON plus audit events.
- Incidents and incident activity.
- Audit logs.
- CIS benchmark version metadata.
- System settings.
- Knowledge documents and chunks with optional pgvector embeddings.
- False-positive reports.

The `KnowledgeChunk.embedding` field uses `vector(1536)`, so production databases should enable the `vector` extension.

## Authentication, MFA, and Roles

SkyShield uses credentials auth through NextAuth.

- Sessions are JWT based with a 30-minute max age.
- Passwords are hashed with bcrypt.
- MFA enrollment is mandatory after password sign-in.
- TOTP secrets are encrypted.
- Recovery codes are generated for users and stored as hashes.
- Admins can reset passwords and reset another user's MFA enrollment.
- Security headers are applied globally and reinforced by `src/proxy.ts`.

Roles:

- `ADMIN`
- `COMPUTER_SECURITY_REVIEW`
- `COMPLIANCE_OFFICER`
- `AUDITOR`
- `VIEWER`

Canonical SCSEM maintenance is restricted to active `ADMIN` or `COMPUTER_SECURITY_REVIEW` users whose organization has `canManageCanonicalScsems` explicitly enabled. Other limited roles can access dashboard, agent, and settings/MFA according to `src/lib/roles.ts`, but cannot see or call SCSEM stewardship pages and APIs.

## Environment Variables

### Required

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | Explicit strong database password required by the included Docker Compose stack; use its URL-safe value in `DATABASE_URL` |
| `AUTH_SECRET` or `NEXTAUTH_SECRET` | Stable, generated NextAuth/session and MFA encryption secret (minimum 32 characters; no placeholders) |
| `NEXTAUTH_URL` | Public app URL |

Generate a stable auth secret with:

```bash
openssl rand -base64 32
```

Keep the configured authentication secret stable across deploys. Rotating it invalidates sessions and may affect encrypted MFA material. Container startup rejects missing, short, placeholder-like, or low-diversity values.

`NEXTAUTH_SECRET` is also accepted by the MFA encryption helper for compatibility, but `AUTH_SECRET` is the preferred variable for new deployments.
The included `docker-compose.yml` intentionally requires an explicit `NEXTAUTH_SECRET` and maps that value to both names; it has no insecure default.

### AI and Retrieval

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIFROST_API_KEY` | unset | Bifrost virtual key. Placeholder or empty values put AI features into demo/fallback mode |
| `BIFROST_BASE_URL` | `http://192.168.16.104:8080/v1` | Bifrost base URL. The app normalizes service root, `/v1`, or `/v1/chat/completions` |
| `BIFROST_MODEL` | `azure/claude-sonnet-4-6` | Main chat model |
| `BIFROST_TITLE_MODEL` | `BIFROST_MODEL` | Conversation title model |
| `BIFROST_SCSEM_MODEL` | `BIFROST_MODEL` | SCSEM update analysis model |
| `BIFROST_EMBEDDING_MODEL` | `azure/text-embedding-ada-002` | Embedding model for knowledge chunks |
| `BIFROST_MAX_OUTPUT_TOKENS` | `6000` | Global max-output clamp for Bifrost requests |
| `BIFROST_CHAT_MAX_TOKENS` | `1200` | Chat-specific output token limit |
| `BIFROST_CHAT_RETRIEVAL_LIMIT` | `6` | Number of retrieved chunks to consider for chat |
| `BIFROST_CHAT_CONTEXT_CHARS` | `14000` | Max retrieved context characters for chat |

### SCSEM Updater

| Variable | Default | Purpose |
| --- | --- | --- |
| `SKYSHIELD_RUNTIME_DATA_DIR` | local `data/`, then OS temp | Writable runtime file root |
| `SCSEM_UPDATER_AI_CONTROL_LIMIT` | `500` | Maximum parsed controls before SCSEM analysis skips AI and uses deterministic fallback |
| `SCSEM_UPDATER_AI_PROMPT_CHAR_LIMIT` | `90000` | Maximum SCSEM AI prompt size |
| `SCSEM_UPDATER_AI_TIMEOUT_MS` | `25000` | SCSEM AI request timeout |
| `SCSEM_UPDATER_ANALYSIS_LEASE_TIMEOUT_MS` | `3600000` | Durable analysis-worker lease; values are clamped to 1 minute–6 hours so a crashed job can be explicitly recovered without racing a live worker |
| `CRON_SECRET` | unset | Separate random bearer secret required for scheduled SCSEM sync routes; missing configuration fails closed |
| `SCSEM_CRON_ORGANIZATION_ID` | unset | ID of an explicitly SCSEM-steward-enabled organization used to own scheduled sync audit records |

### Startup and Seeding

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOOTSTRAP_ADMIN_EMAIL` | unset | Email for the manually invoked, one-shot initial administrator command |
| `BOOTSTRAP_ADMIN_NAME` | unset | Display name for that one initial administrator |
| `BOOTSTRAP_ADMIN_PASSWORD` | unset | Strong password used only for that single identity |
| `BOOTSTRAP_ORGANIZATION_NAME` | unset | New organization created by the one-shot bootstrap |
| `BOOTSTRAP_ORGANIZATION_SLUG` | unset | New lowercase organization slug |
| `BOOTSTRAP_CAN_MANAGE_CANONICAL_SCSEMS` | unset | Must be explicitly `true` only for the designated canonical-template steward organization |
| `SEED_USER_PASSWORDS_JSON` | unset | Destructive disposable-environment seed only: a distinct strong password for every named seed identity |
| `SEED_CAN_MANAGE_CANONICAL_SCSEMS` | `false` | Destructive disposable-environment seed only: mark its organization as a canonical-template steward |

Production startup never creates or modifies named users. On a new, empty deployment, run `npm run users:bootstrap-admin` once with the six `BOOTSTRAP_*` variables above. The command refuses to run when any user or the requested organization already exists and writes the administrator and its audit event in one database transaction. Use authenticated invitations for every later identity; do not leave bootstrap secrets in normal runtime configuration.

The legacy `prisma/seed.ts` resets several data tables and imports bundled SCSEM templates. It is never called by production startup. Use it only through the explicit local command in an authorized disposable environment.

## Local Development

### Prerequisites

- Node.js 20+
- npm
- PostgreSQL 16+
- pgvector extension, or the `pgvector/pgvector:pg16` Docker image
- Optional Bifrost virtual key for live AI
- Optional authorized CIS SecureSuite credentials provisioned through the deployment's approved secret-management process

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
```

Minimum local `.env`:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/irs_skyshield?schema=public"
AUTH_SECRET="replace-with-a-stable-generated-secret"
AUTH_TRUST_HOST=true
NEXTAUTH_URL="http://localhost:3000"

BIFROST_API_KEY="sk-bf-placeholder"
BIFROST_BASE_URL="http://192.168.16.104:8080/v1"
BIFROST_MODEL="azure/claude-sonnet-4-6"
BIFROST_EMBEDDING_MODEL="azure/text-embedding-ada-002"

SKYSHIELD_RUNTIME_DATA_DIR="./data"
```

### Database Setup

```bash
npm run db:generate
npm run db:migrate
```

For a brand-new empty database, configure the one identity and organization described under “Startup and Seeding,” run `npm run users:bootstrap-admin` once, remove the bootstrap variables, sign in, enroll MFA, and invite each additional user individually.

Optional local knowledge import:

```bash
npm run rag:sync:pub1075
npm run rag:ingest:interim-guidance
```

Optional legacy local SCSEM seed:

```bash
npm run db:seed
```

### Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Docker Deployment

Build and run the app with PostgreSQL and pgvector:

```bash
docker compose up -d --build
```

Services:

- `app`: Next.js production server on port 3000.
- `db`: `pgvector/pgvector:pg16` PostgreSQL service.

Container startup behavior:

1. Validate the required authentication secret.
2. Wait for the database and run `prisma migrate deploy`.
3. Start `next start`.

The production image healthcheck calls `/api/health`. That public endpoint returns only minimal ready/not-ready state, uses HTTP 503 when required sources or the database are unavailable, and does not expose environment values or internal inventory. The Dockerfile includes `poppler-utils` for document/PDF handling and uses `/var/lib/skyshield` for runtime data.

Example production environment:

```env
POSTGRES_PASSWORD=replace-with-a-strong-url-safe-database-password
DATABASE_URL=postgresql://postgres:replace-with-a-strong-url-safe-database-password@db:5432/irs_skyshield?schema=public
NEXTAUTH_SECRET=your-stable-generated-production-secret
AUTH_TRUST_HOST=true
NEXTAUTH_URL=https://your-domain.example

BIFROST_API_KEY=sk-bf-your-virtual-key
BIFROST_BASE_URL=http://192.168.16.104:8080/v1
BIFROST_MODEL=azure/claude-sonnet-4-6
BIFROST_TITLE_MODEL=azure/claude-sonnet-4-6
BIFROST_SCSEM_MODEL=azure/claude-sonnet-4-6
BIFROST_EMBEDDING_MODEL=azure/text-embedding-ada-002

# Supply one CIS credential form through approved secret injection.
CIS_LICENSE_XML_PATH=/run/secrets/cis-securesuite-license.xml
# CIS_LICENSE_XML_BASE64=base64-encoded-license-xml

SKYSHIELD_RUNTIME_DATA_DIR=/var/lib/skyshield
SCSEM_UPDATER_AI_CONTROL_LIMIT=500
SCSEM_UPDATER_AI_PROMPT_CHAR_LIMIT=90000
SCSEM_UPDATER_AI_TIMEOUT_MS=25000

# Do not place one-shot BOOTSTRAP_* credentials in normal runtime configuration.
# Supply them only to `npm run users:bootstrap-admin` on a new empty database.
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start Next.js dev server with Turbopack |
| `npm run build` | Generate Prisma client and build Next.js |
| `npm run start` | Start production Next.js server |
| `npm run lint` | Run Next lint command |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:migrate` | Apply committed Prisma migrations |
| `npm run db:migrate:dev` | Create/apply a local development migration |
| `npm run db:push` | Push schema directly for prototyping |
| `npm run db:seed` | Run legacy seed script |
| `npm run users:bootstrap-admin` | Create exactly one audited initial administrator in an empty database; never run during normal startup |
| `npm run rag:ingest:interim-guidance` | Import bundled IRS interim guidance |
| `npm run rag:ingest:pub1075` | Import local Publication 1075 text |
| `npm run rag:sync:pub1075` | Download official Publication 1075 and import/embed it |
| `npm run rag:sync:nist80053` | Refresh the normalized NIST SP 800-53 Rev. 5 OSCAL fallback snapshot |
| `npm run db:studio` | Open Prisma Studio |

## Project Structure

```text
data/
  nist/                          Normalized NIST SP 800-53 OSCAL fallback controls
  pub1075/                       Publication 1075 source files
  scsem-index.json               Bundled SCSEM metadata
  scsems/                        Bundled IRS SCSEM workbooks
prisma/
  migrations/                    Database migrations
  schema.prisma                  Prisma schema
  seed.ts                        Legacy local seed/import script
scripts/
  bootstrap-admin.ts             One-shot initial administrator creation
  sync-pub1075.ts                Acquire a candidate Pub 1075 snapshot for governed review/promotion
  ingest-*.ts                    Knowledge ingestion helpers
src/
  app/                           Next.js pages and API routes
  components/                    Client/server UI components
  lib/                           Auth, audit, AI, knowledge, SCSEM, workbook utilities
public/                          Static assets and bundled guidance
Dockerfile                       Production image
docker-compose.yml               Local app/db stack
entrypoint.sh                    Container validation/migration/startup flow
SPEC.md                          Product specification
```

## Security and Compliance Notes

- PII/FTI prompts are blocked before they are sent to Bifrost.
- Blocked AI prompts create incident records and audit events.
- AI input/output and SCSEM updater input/output summaries are written to audit metadata.
- MFA is mandatory for authenticated users.
- Admin reset actions are audited.
- Role checks are enforced in `src/proxy.ts` and API handlers.
- Canonical SCSEM pages and APIs are limited to active `ADMIN` or `COMPUTER_SECURITY_REVIEW` users in an explicitly steward-enabled organization; updater sessions are additionally scoped to their creator and organization.
- SCSEM workbook uploads enforce extension, size, and Office Open XML file-signature checks.
- Security headers are added globally through `next.config.ts` and reinforced for protected routes by `src/proxy.ts`.
- Runtime uploads should be stored outside the immutable app bundle in production.
- Pinned IRS, Publication 1075, NIST, CIS Benchmark, and CIS-STIG source artifacts are retained or referenced with versions and hashes for traceability.
- AI output is not authoritative by itself. Reviewers must validate every proposed template change against the pinned Publication 1075 and NIST sources, applicable licensed CIS Benchmark/CIS-STIG workbooks, independently consulted authoritative sources when required, and Office of Safeguards policy.
- Candidate XLSX exports are not agency assessments, compliance certifications, or official SCSEM releases.
- Production deployments should validate environment-level TLS/FIPS, database encryption, network segmentation, firewall rules, and SIEM forwarding with the hosting agency's boundary and operations teams.

## Troubleshooting

### `EACCES: permission denied, mkdir '/app/data/scsem-updater'`

Set a writable runtime directory and mount it in the container:

```env
SKYSHIELD_RUNTIME_DATA_DIR=/var/lib/skyshield
```

In docker-compose, keep the `skyshield_runtime_data:/var/lib/skyshield` volume.

### `No matching CIS Benchmark Excel workbook was found`

This means no catalog candidate passed local content, product-generation, profile, and control-overlap validation. The UI shows the attempted sheet/query and rejection reason. Other pinned-source comparisons may still run, but CIS coverage remains unresolved and the result must not be treated as a complete or release-ready review. Confirm:

- The CIS license has access to that benchmark family.
- The benchmark has an Excel download available.
- The technology is covered by a CIS Benchmark or CIS-STIG workbook in CIS WorkBench at all.
- An authorized Office of Safeguards reviewer has confirmed the benchmark/profile is applicable and that its licensed content may be used for the proposed change.

Renaming the file or tabs is normally unnecessary because titles are not sent as a CIS search call. Some IRS SCSEMs have no direct CIS equivalent; AWS Foundations is also nested in the IRS Cloud SCSEM rather than published as an “AWS SCSEM.”

### `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

This usually means the frontend received an HTML error page instead of an API JSON response. Check server logs for the real API error, auth/session state, reverse proxy behavior, and whether the request hit the correct `/api/scsem-updater/...` route.

### AI JSON parse failures during SCSEM analysis

Large workbooks can exceed practical structured-output limits. The updater catches malformed AI JSON and uses deterministic fallback changes. Tune:

```env
SCSEM_UPDATER_AI_CONTROL_LIMIT=500
SCSEM_UPDATER_AI_PROMPT_CHAR_LIMIT=90000
SCSEM_UPDATER_COMPLIANCE_MAX_BATCHES=6
SCSEM_UPDATER_COMPLIANCE_BATCH_CONCURRENCY=4
SCSEM_UPDATER_AI_TIMEOUT_MS=25000
```

### Slow deployment startup

Container startup always validates configuration and runs migrations. It never creates or modifies named users and never invokes the destructive legacy seed.

### Knowledge search has no embeddings

The app still uses exact, keyword, and full-text search without embeddings. To enable vector retrieval, configure `BIFROST_API_KEY`, `BIFROST_EMBEDDING_MODEL`, and pgvector, then rerun knowledge ingestion.

## Current Limitations

- SCSEM updater matching depends on authorized access to current CIS Benchmark and CIS-STIG workbooks in CIS WorkBench; unavailable or unmatched sources leave an explicit unresolved condition.
- Some SCSEMs may have only CIS-STIG evidence or no direct CIS Benchmark/CIS-STIG equivalent. The app must not infer complete source coverage from that absence.
- Independent DISA STIG ingestion and release validation are not implemented.
- Source comparison and AI/deterministic rationale assist drafting, but an authorized reviewer owns applicability and template-content decisions. Separate Office of Safeguards governance owns canonical release approval.
- Export preserves formatting by editing the original workbook, but extremely unusual workbook constructs should be reviewed manually after export.
- `prisma/seed.ts` is legacy and can delete/reset local data. Prefer migrations, the one-shot initial-admin command, and authenticated invitations for normal setup.
