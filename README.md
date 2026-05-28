# IRS SkyShield

IRS SkyShield is an internal compliance workspace for IRS Publication 1075, SCSEM workbook maintenance, security incident handling, and auditable AI-assisted analysis.

The app is built around a human-review workflow. AI and deterministic matching can propose updates, cite supporting evidence, and explain why a control should change, but reviewers still approve, reject, edit, undo, and export the final result.

## Core Capabilities

- AI Compliance Agent: Ask questions about Publication 1075 and related guidance with retrieved source context, citations, and audit metadata.
- SCSEM Updater: Upload an IRS Safeguards SCSEM workbook, match it to current CIS SecureSuite and STIG benchmark workbooks, compare controls, review proposed updates, and export an updated XLSX.
- Workbook Fidelity: SCSEM exports start from the original uploaded workbook so formatting, colors, filters, sheet structure, and workbook styling are preserved as closely as possible.
- Audit Log Drilldowns: Audit entries are clickable and show structured details such as input, output, retrieval context, action metadata, and raw JSON.
- Incident Tracking: Capture, triage, and document incidents including PII/FTI detection events from the agent.
- Knowledge Base: Ingest Publication 1075, IRS interim guidance, and other supporting documents for hybrid search and retrieval.
- MFA and RBAC: Credential auth, mandatory TOTP enrollment, recovery codes, role-gated navigation, and admin account recovery.
- Deployment Ready: Dockerized Next.js app with PostgreSQL, pgvector, Prisma migrations, runtime upload storage, and a health endpoint.

## Product Model

SkyShield has two important operating principles:

1. Source material remains auditable.
   Uploaded SCSEM files, downloaded CIS benchmark Excel files, STIG benchmark files, source metadata, release dates, file hashes, and generated update decisions are retained in runtime storage or the database so a reviewer can reconstruct what was used.

2. Human review remains mandatory.
   The app can identify likely updates, stricter requirements, missing controls, and conflicts between SCSEM, CIS, STIG, and Publication 1075 sources. It does not silently rewrite the final workbook. Reviewers approve, reject, edit, undo, and export.

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

This page replaces the old static SCSEM browser as the primary SCSEM workflow.

1. A reviewer uploads or drags in an IRS workbook named like `Safeguards-SCSEM (Technology).xlsx`.
2. The server stores the original workbook under runtime storage and creates an updater session.
3. The workbook is parsed to identify sheets, test-case rows, headers, control fields, NIST IDs, CIS references, recommendation numbers, and existing release/change-log sheets.
4. The app infers the target technology from the workbook name and workbook metadata. Examples include Windows 11, Windows Server, RHEL, Oracle Database, Cisco, and other SCSEM technology families.
5. The CIS SecureSuite API is used to list available benchmarks and Excel files.
6. The app selects the latest matching CIS Benchmark workbook and the latest matching CIS STIG Benchmark workbook when available.
7. Downloaded benchmark workbooks are stored as audit snapshots with title, version, release date, filename, workbench ID, local path, download time, and SHA-256 hash.
8. Benchmark recommendations are parsed and profile-matched against the SCSEM.
9. The comparison engine builds update candidates for existing controls and new-control candidates for recommendations missing from the SCSEM.
10. Publication 1075 excerpts are pulled from `data/pub1075/p1075-full-text.md` using the relevant NIST control families.
11. CIS, STIG, and Publication 1075 evidence is compared. When sources conflict, the proposed update should favor the stricter and more secure control language, subject to reviewer validation.
12. For smaller sessions, Bifrost can produce structured, explainable recommendations. For large workbooks, missing AI configuration, AI timeouts, or malformed AI JSON, the app falls back to deterministic recommendations.
13. The UI shows each proposed change with source evidence, target field, current value, proposed value, rationale, and approval controls.
14. Reviewers can approve, reject, edit proposed text, edit rationale, edit new-control content, batch review, undo the last review action, or export at any time.
15. Export applies approved changes only and returns an updated `.xlsx`.

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

New controls can also be appended when a CIS or STIG recommendation appears applicable and is not already represented in the uploaded SCSEM.

#### Workbook Export Behavior

Export uses the uploaded workbook as the base file.

- Existing approved cell updates are written into the matching test-case row and column.
- Approved new controls are appended to the appropriate sheet with copied row formatting where possible.
- Existing workbook styles, filters, colors, widths, sheet names, and workbook structure are preserved by editing the original XLSX package rather than regenerating a workbook from scratch.
- If no changes have been approved, export returns the original workbook bytes.
- If the workbook includes `Change Log` or `New Release Changes` sheets, export appends release/update entries for approved changes.

This is designed to keep the output visually and structurally equivalent to the input workbook, with only approved reviewer changes applied.

#### Matching Notes

Not every IRS SCSEM has a one-to-one CIS Benchmark Excel workbook. The matcher uses normalized title scoring, version/date comparison, aliases, accepted benchmark status, and Excel availability. If a standard CIS benchmark is not found but a STIG benchmark is found, the updater can proceed with STIG-only evidence. If neither source has a confident match, the UI reports that no matching workbook/profile was found instead of inventing a source.

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
| `/dashboard` | Compliance overview, activity, incidents, and quick links |
| `/agent` | AI compliance assistant |
| `/scsems` | SCSEM Updater upload, analysis, review, undo, and export |
| `/scsems/[id]` | Legacy SCSEM detail route retained for existing data |
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
| `/api/health` | GET | Public health check with database, Pub 1075, knowledge, and AI config status |
| `/api/auth/[...nextauth]` | GET, POST | NextAuth routes |
| `/api/mfa` | GET, POST | TOTP setup, verification, disable, and recovery-code rotation |
| `/api/chat` | GET, POST, PATCH | Conversations, agent messages, and bookmarks |
| `/api/dashboard` | GET | Dashboard metrics |
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
| `/api/scsem-updater/[id]` | GET | Load updater session |
| `/api/scsem-updater/[id]/analyze` | POST | Run CIS/STIG/Pub 1075 analysis |
| `/api/scsem-updater/[id]/changes` | PATCH | Approve, reject, edit, or batch-review proposed changes |
| `/api/scsem-updater/[id]/undo` | POST | Undo last review action |
| `/api/scsem-updater/[id]/export` | GET | Export approved changes to XLSX |
| `/api/scsems/[id]` | GET | Legacy SCSEM template detail |
| `/api/scsems/[id]/export` | GET | Legacy SCSEM export |
| `/api/scsems/[id]/review` | POST | Legacy SCSEM review |
| `/api/scsems/sync` | POST | Legacy SCSEM sync |
| `/api/scsems/sync-pub1075` | POST | Pub 1075 sync helper |
| `/api/scsems/update-pub1075` | POST | Legacy Pub 1075 update helper |
| `/api/test-ai` | GET | AI connectivity test |

## Data and Storage

### Repository Data

| Path | Purpose |
| --- | --- |
| `data/pub1075/p1075.pdf` | Bundled Publication 1075 PDF |
| `data/pub1075/p1075-full-text.md` | Extracted Publication 1075 text used by SCSEM analysis and fallback context |
| `data/scsem-index.json` | Metadata for bundled IRS SCSEM templates |
| `data/scsems/` | 58 bundled IRS SCSEM workbooks organized by technology category |
| `public/` | Static assets and bundled interim guidance text |
| `assets/license.xml` | Local CIS SecureSuite license file used to obtain a vendor API token |

`assets/license.xml` is required for CIS API downloads. Treat it as sensitive operational material. Do not publish license contents in docs, tickets, logs, or screenshots.

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

The docker-compose file mounts this path as the `skyshield_runtime_data` volume. SCSEM uploads, updater sessions, exported workbook working data, and downloaded CIS/STIG benchmark snapshots should use runtime storage rather than the application bundle.

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
- Security headers are applied through `src/proxy.ts`.

Roles:

- `ADMIN`
- `COMPUTER_SECURITY_REVIEW`
- `COMPLIANCE_OFFICER`
- `AUDITOR`
- `VIEWER`

Admins can access all routes. Limited roles can access dashboard, agent, SCSEM Updater, settings/MFA, and the corresponding API routes defined in `src/lib/roles.ts`.

## Environment Variables

### Required

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_SECRET` | NextAuth/session and MFA encryption secret |
| `NEXTAUTH_URL` | Public app URL |

Generate a stable auth secret with:

```bash
openssl rand -base64 32
```

Keep `AUTH_SECRET` stable across deploys. Rotating it invalidates sessions and may affect encrypted MFA material.

`NEXTAUTH_SECRET` is also accepted by the MFA encryption helper for compatibility, but `AUTH_SECRET` is the preferred variable for new deployments.

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

### Startup and Seeding

| Variable | Default | Purpose |
| --- | --- | --- |
| `SKYSHIELD_SYNC_PRODUCTION_USERS` | `true` in entrypoint | Sync configured baseline users on container startup |
| `SKYSHIELD_RUN_LEGACY_SCSEM_SEED` | unset/false | Run the legacy Prisma seed during startup |
| `SEED_ADMIN_PASSWORD` | script default | Password used by `scripts/sync-production-users.ts` for configured admin users |
| `SEED_COMPUTER_SECURITY_REVIEW_PASSWORD` | script default | Password used by `scripts/sync-production-users.ts` for configured Computer Security Review users |

The legacy `prisma/seed.ts` resets several data tables and imports bundled SCSEM templates. Use it intentionally in local development. Do not treat it as a normal production startup task.

## Local Development

### Prerequisites

- Node.js 20+
- npm
- PostgreSQL 16+
- pgvector extension, or the `pgvector/pgvector:pg16` Docker image
- Optional Bifrost virtual key for live AI
- Optional CIS SecureSuite license file at `assets/license.xml` for SCSEM updater benchmark downloads

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
npm run users:sync
```

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

1. Wait for the database.
2. Run `prisma migrate deploy`.
3. Sync baseline users when `SKYSHIELD_SYNC_PRODUCTION_USERS=true`.
4. Run the legacy SCSEM seed only when `SKYSHIELD_RUN_LEGACY_SCSEM_SEED=true`.
5. Start `next start`.

The production image healthcheck calls `/api/health`. The Dockerfile includes `poppler-utils` for document/PDF handling and uses `/var/lib/skyshield` for runtime data.

Example production environment:

```env
DATABASE_URL=postgresql://postgres:your-password@db:5432/irs_skyshield?schema=public
AUTH_SECRET=your-stable-production-secret
AUTH_TRUST_HOST=true
NEXTAUTH_URL=https://your-domain.example

BIFROST_API_KEY=sk-bf-your-virtual-key
BIFROST_BASE_URL=http://192.168.16.104:8080/v1
BIFROST_MODEL=azure/claude-sonnet-4-6
BIFROST_TITLE_MODEL=azure/claude-sonnet-4-6
BIFROST_SCSEM_MODEL=azure/claude-sonnet-4-6
BIFROST_EMBEDDING_MODEL=azure/text-embedding-ada-002

SKYSHIELD_RUNTIME_DATA_DIR=/var/lib/skyshield
SCSEM_UPDATER_AI_CONTROL_LIMIT=500
SCSEM_UPDATER_AI_PROMPT_CHAR_LIMIT=90000
SCSEM_UPDATER_AI_TIMEOUT_MS=25000

SKYSHIELD_SYNC_PRODUCTION_USERS=true
SKYSHIELD_RUN_LEGACY_SCSEM_SEED=false
SEED_ADMIN_PASSWORD=rotate-this
SEED_COMPUTER_SECURITY_REVIEW_PASSWORD=rotate-this-too
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
| `npm run users:sync` | Upsert configured baseline users |
| `npm run rag:ingest:interim-guidance` | Import bundled IRS interim guidance |
| `npm run rag:ingest:pub1075` | Import local Publication 1075 text |
| `npm run rag:sync:pub1075` | Download official Publication 1075 and import/embed it |
| `npm run db:studio` | Open Prisma Studio |

## Project Structure

```text
data/
  pub1075/                       Publication 1075 source files
  scsem-index.json               Bundled SCSEM metadata
  scsems/                        Bundled IRS SCSEM workbooks
prisma/
  migrations/                    Database migrations
  schema.prisma                  Prisma schema
  seed.ts                        Legacy local seed/import script
scripts/
  sync-production-users.ts       Baseline user sync
  sync-pub1075.ts                Official Pub 1075 sync/import
  ingest-*.ts                    Knowledge ingestion helpers
src/
  app/                           Next.js pages and API routes
  components/                    Client/server UI components
  lib/                           Auth, audit, AI, knowledge, SCSEM, workbook utilities
public/                          Static assets and bundled guidance
Dockerfile                       Production image
docker-compose.yml               Local app/db stack
entrypoint.sh                    Container migration/user-sync/startup flow
SPEC.md                          Product specification
```

## Security and Compliance Notes

- PII/FTI prompts are blocked before they are sent to Bifrost.
- Blocked AI prompts create incident records and audit events.
- AI input/output and SCSEM updater input/output summaries are written to audit metadata.
- MFA is mandatory for authenticated users.
- Admin reset actions are audited.
- Role checks are enforced in `src/proxy.ts` and API handlers.
- Security headers are added by the proxy.
- Runtime uploads should be stored outside the immutable app bundle in production.
- CIS source files are retained with hashes for traceability.
- AI output is not considered authoritative by itself. Reviewers must validate proposed changes against Publication 1075, applicable STIG requirements, CIS source workbooks, and agency policy.

## Troubleshooting

### `EACCES: permission denied, mkdir '/app/data/scsem-updater'`

Set a writable runtime directory and mount it in the container:

```env
SKYSHIELD_RUNTIME_DATA_DIR=/var/lib/skyshield
```

In docker-compose, keep the `skyshield_runtime_data:/var/lib/skyshield` volume.

### `No matching CIS Benchmark Excel workbook was found`

This means the uploaded SCSEM technology did not confidently match an available CIS Benchmark Excel file. The app also tries STIG benchmark matching. If neither source matches, the reviewer should confirm:

- The SCSEM filename includes the actual technology.
- The CIS license has access to that benchmark family.
- The benchmark has an Excel download available.
- The technology is covered by CIS or STIG at all.

Some IRS SCSEMs may not have a direct CIS Excel equivalent.

### `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

This usually means the frontend received an HTML error page instead of an API JSON response. Check server logs for the real API error, auth/session state, reverse proxy behavior, and whether the request hit the correct `/api/scsem-updater/...` route.

### AI JSON parse failures during SCSEM analysis

Large workbooks can exceed practical structured-output limits. The updater catches malformed AI JSON and uses deterministic fallback changes. Tune:

```env
SCSEM_UPDATER_AI_CONTROL_LIMIT=500
SCSEM_UPDATER_AI_PROMPT_CHAR_LIMIT=90000
SCSEM_UPDATER_AI_TIMEOUT_MS=25000
```

### Slow deployment startup

The current container startup runs migrations and user sync. The legacy SCSEM seed is disabled unless `SKYSHIELD_RUN_LEGACY_SCSEM_SEED=true`. Keep that flag false in production unless intentionally reimporting legacy SCSEM data.

### Knowledge search has no embeddings

The app still uses exact, keyword, and full-text search without embeddings. To enable vector retrieval, configure `BIFROST_API_KEY`, `BIFROST_EMBEDDING_MODEL`, and pgvector, then rerun knowledge ingestion.

## Current Limitations

- SCSEM updater matching depends on available CIS SecureSuite API data and workbook downloads.
- Some SCSEMs may only have STIG evidence or no direct benchmark equivalent.
- The stricter-control decision is assisted by source comparison and AI/deterministic rationale, but the reviewer is responsible for final compliance interpretation.
- Export preserves formatting by editing the original workbook, but extremely unusual workbook constructs should be reviewed manually after export.
- `prisma/seed.ts` is legacy and can delete/reset local data. Prefer migrations plus `npm run users:sync` for normal setup.
