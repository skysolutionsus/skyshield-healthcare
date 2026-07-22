# IRS SkyShield — Product Specification

## Overview
IRS SkyShield is an internal application for authorized IRS Office of Safeguards personnel. It supports cited Publication 1075 research, canonical Safeguards Computer Security Evaluation Matrix (SCSEM) template stewardship, incident operations, and auditability.

The SCSEM Updater maintains the canonical template source that may later be published for agencies to use as guidance. Agencies do not submit implementations, control evidence, findings, or assessment results through this workflow. SkyShield does not assess or certify an agency, certify a technology, or publish an official SCSEM release. It produces source-attributed candidate changes and candidate workbooks for authorized human review and a separately governed Office of Safeguards release process.

## Core Value Proposition
- **Instant Pub 1075 guidance** — ask questions in plain English, get cited answers with section references
- **Canonical SCSEM stewardship** — verify the pinned IRS source set, compare standards evidence, review candidate template changes, and export candidate workbooks without collecting agency assessment data
- **Incident tracking** — log and manage FTI/PII exposure incidents with remediation workflows
- **FTI/PII guardrails** — the app itself rejects any FTI/PII input, creating incident reports if users attempt to submit sensitive data
- **Web search integration** — cross-reference Pub 1075 requirements with real-world technologies (CrowdStrike, Windows, etc.)
- **CIS Benchmark/CIS-STIG evidence tracking** — retain CIS WorkBench identity, version, profile, release metadata, license-authorized retrieval, and hashes; flag candidate deltas and unresolved applicability for reviewer disposition

## Architecture

### Tech Stack
- **Framework:** Next.js 15 (App Router)
- **UI:** Tailwind CSS + shadcn/ui components
- **Database:** PostgreSQL (for multi-tenant data, audit logs, incidents)
- **ORM:** Prisma
- **Auth:** NextAuth.js v5 with role-based access; canonical SCSEM stewardship is restricted to explicitly authorized Admin and Computer Security Review users in a steward-enabled organization
- **AI:** Claude Sonnet 4.6 via Bifrost chat completions on Microsoft Foundry
- **Search:** Brave Search API or similar for web augmentation
- **Deployment:** Docker → Coolify on Hetzner VPS

### Multi-Tenant Architecture
- Organizations have isolated workspaces for the broader platform
- Users belong to organizations with role-based permissions
- Organization membership alone does not grant SCSEM access. Canonical template maintenance requires an explicit steward-organization flag plus an authorized role.
- The SCSEM workflow is not an agency-facing assessment workspace; its organization boundary identifies the authorized Office of Safeguards stewardship group and scopes each updater session to its creator.
- All actions are audit-logged (who, what, when, from where)
- Data isolation between organizations

## Features

### 1. AI Compliance Agent (Primary Feature)
The heart of the app. A chat interface where compliance workers ask questions and get Pub 1075-cited answers.

**Behavior:**
- Full Publication 1075 text loaded into system prompt context (~600K characters fits in 1M token window)
- Every response MUST cite specific sections, paragraphs, and page numbers from Pub 1075
- If the answer isn't in Pub 1075, the agent says so clearly and offers to web search
- Agent can cross-reference SCSEM requirements for specific technologies
- Agent maintains conversation history per user (stored in DB, not just session)

**FTI/PII Guardrails (CRITICAL):**
- Before sending ANY user message to the Bifrost AI endpoint, run PII/FTI detection:
  - SSN patterns (XXX-XX-XXXX, XXXXXXXXX)
  - EIN patterns (XX-XXXXXXX)
  - Tax return data patterns
  - Names + financial amounts together
  - Any data that looks like it could be from a tax return
- If detected: BLOCK the message, DO NOT send to Bifrost, show warning to user
- Auto-create an incident report logging the attempt (user, timestamp, type of data detected, sanitized excerpt)
- Provide a "Report False Positive" button if the detection was wrong

**Web Search Integration:**
- User can ask "How does CrowdStrike Falcon map to Pub 1075 Section 9.3.16.6?" 
- Agent searches the web for current CrowdStrike documentation
- Cross-references findings with Pub 1075 requirements
- Provides a synthesized answer with both Pub 1075 citations AND web sources

**Conversation Features:**
- Save/bookmark important conversations
- Share conversation threads with team members
- Export conversations as PDF compliance documentation

### 2. Dashboard (Home Screen)
Clean, simple overview. Think Vercel Dashboard — minimal, functional.

**Widgets:**
- **SCSEM Source Set** — pinned official template count, manifest retrieval date, and source-integrity status
- **Candidate Review Queue** — pending/approved/rejected template proposals and incomplete-source sessions
- **Open Incidents** — count + severity breakdown (Critical/High/Medium/Low)
- **Recent Activity** — audit log feed (last 20 actions)
- **SCSEM Status** — source freshness, candidate drafts, and unresolved CIS Benchmark/CIS-STIG applicability (never agency compliance status)
- **Upcoming Deadlines** — internal template review/release dates and incident deadlines
- **Quick Actions** — "Ask Agent", "Report Incident", "Open SCSEM Updater"

### 3. Canonical SCSEM Template Stewardship
Maintain the current IRS-published SCSEM template set and prepare candidate workbooks for release review. This feature is for Office of Safeguards template owners, not agencies performing control assessments.

**Features:**
- **Pinned official source set** — each accepted IRS SCSEM from the page's individual XLSX links is represented in a manifest with its official URL, filename, technology/category, version/effective date when available, retrieval metadata, and SHA-256 hash. Unrecognized or modified uploads are not silently promoted to canonical input. A concurrently linked package archive that differs from those individual downloads is recorded as a reconciliation source, not silently allowlisted as equivalent canonical bytes.
- **Template-content workflow** — parse controls, formulas, sheets, styles, validation rules, and change-log structure; propose changes only to approved canonical template-content fields. Agency response/assessment fields are outside the workflow and must not be imported, inferred, carried forward, or intentionally modified.
- **Standards evidence:**
  - Pin the Publication 1075 source used for governing policy evidence.
  - Pin the NIST SP 800-53 Rev. 5 snapshot used for secondary control mapping.
  - Record CIS SecureSuite WorkBench ID, benchmark/version/profile, license-authorized retrieval, release metadata, and content hash for CIS Benchmark and CIS-published STIG profile workbooks ("CIS-STIG").
  - Do not represent CIS-STIG retrieval as independent validation against the authoritative DISA STIG library or DISA release history; that validation is not implemented and remains an external reviewer responsibility.
  - Treat source availability, title similarity, and automated overlap as evidence—not as an applicability decision. An authorized reviewer must confirm technology generation, profile, scope, source authority, and licensing/permitted use.
- **Candidate change review:**
  - Show the exact target sheet/control/field, current value, proposed value, rationale, source evidence, and confidence.
  - Allow authorized reviewers to edit permitted proposal fields, approve or reject for the candidate draft, batch review, and undo.
  - Keep machine rationale and source identity immutable in the review UI.
  - Mark a session `analysis_incomplete` when required source, AI, or direct applicability coverage is unresolved. Other successful comparisons do not turn that state into a "complete review."
- **Candidate export:**
  - Apply only reviewer-approved template-content changes to the verified canonical base while preserving workbook structure, formulas, styles, validation, filters, and sheet layout.
  - Never carry forward actual results, agency status, notes/evidence, agency remediation/CAP text, or other agency-entered assessment-response content.
  - Treat standard finding text, criticality, issue-code mappings, and risk formulas as template-owned control metadata. Require reviewer-approved standard finding text when the selected sheet has a unique Finding Statement column, while preserving layouts that do not contain that column. Require a reviewer-selected code that exists uniquely in the verified workbook's `Issue Code Table`; derive its mapping text from that table and never clone another control's issue code as a default.
  - Return unchanged original bytes when no approved change or official structural rebase is required.
  - Label exports from incomplete sessions as working drafts.
  - Treat every export as a candidate XLSX requiring native Excel inspection and separate Office of Safeguards quality-control and release approval.

**Explicit non-goals:**
- Agency system/control submission or evidence collection
- Agency compliance scoring, findings management, attestation, or certification
- Automatic CIS Benchmark/CIS-STIG applicability decisions
- Independent DISA STIG ingestion or release validation
- Automatic publication or designation of an official SCSEM release

### 4. Incident Management
Track and manage FTI/PII incidents.

**Incident Types:**
- FTI Exposure (unauthorized disclosure)
- PII Breach
- Unauthorized Access
- System Compromise
- Policy Violation
- Auto-generated (from PII/FTI guardrail triggers)

**Incident Fields:**
- Title, Description, Type, Severity (Critical/High/Medium/Low)
- Date discovered, Date occurred
- Affected systems/data
- Assigned to (user)
- Status: Open → Investigating → Remediation → Resolved → Closed
- Remediation plan (text + checklist)
- Timeline/activity log
- Related Pub 1075 sections (auto-suggested by AI agent)

**Notifications:**
- Email alerts for new Critical/High incidents
- Dashboard alerts for assigned incidents
- Escalation rules (if incident not updated in X days)

### 5. Audit Log
Every action in the system is logged. Non-deletable.

**Logged Events:**
- User login/logout (with IP, user agent)
- AI agent queries (question asked, NOT the full response to save space)
- SCSEM source verification, candidate analysis, proposal review/undo, incomplete-source disposition, and candidate export events
- Incident creation/updates
- User management changes
- Configuration changes
- FTI/PII detection events (always logged, even false positives)

**Audit Log UI:**
- Searchable, filterable table
- Export as CSV/PDF
- Date range filtering
- Filter by user, action type, severity

### 6. User Management (Admin)
- Invite users by email
- Assign roles: Admin, Computer Security Review, Compliance Officer, Auditor, Viewer
- Role permissions:
  - **Admin:** User and organization administration; canonical SCSEM access only when the user's organization is explicitly steward-enabled
  - **Computer Security Review:** Canonical SCSEM stewardship only when the user's organization is explicitly steward-enabled
  - **Compliance Officer:** Broader platform workflows permitted by policy, but no canonical SCSEM page or API access
  - **Auditor:** Read-only access permitted by broader platform policy, but no canonical SCSEM page or API access
  - **Viewer:** Limited dashboard/incidents access, but no canonical SCSEM page or API access
- Deactivate/remove users
- View user activity

### 7. Organization Settings
- Organization name, logo
- Notification preferences
- Steward-organization authorization and internal SCSEM review/release schedule
- Custom incident categories
- API key management (for future integrations)

## Data Model (Key Entities)

```
Organization
  - id, name, slug, logo, canManageCanonicalScsems, createdAt

User
  - id, email, name, role, organizationId, lastLogin, createdAt

Conversation
  - id, userId, title, createdAt, bookmarked

Message
  - id, conversationId, role (user/assistant), content, citations[], createdAt

SCSEMTemplate
  - id, name, category, version, effectiveDate, cisVersion, filePath

SCSEMSheet / SCSEMControl / SCSEMChangeLog
  - parsed canonical template content and source release history

SCSEMUpdateReview
  - id, templateId, benchmarkId, status, suggestedChanges, reviewedBy, reviewedAt

SCSEMUpdaterSession (runtime, steward- and creator-scoped)
  - id, originalFileName, uploadedSha256, sourceManifestEntry, status, changes[], history[], audit

SCSEMSourceManifest (repository data)
  - officialUrl, fileName, technology, category, version/effectiveDate, retrievedAt, sha256

Incident
  - id, organizationId, title, description, type, severity, status, assignedTo, createdAt, resolvedAt

IncidentActivity
  - id, incidentId, userId, action, details, createdAt

AuditLog
  - id, organizationId, userId, action, resourceType, resourceId, metadata, ipAddress, userAgent, createdAt

CISBenchmarkVersion
  - id, technology, currentVersion, lastChecked, scsemsAffected[]
```

## Design Principles

1. **Government-grade simple.** No flashy animations. Clean, professional, accessible. Think login.gov aesthetic.
2. **Dark mode by default** with light mode option. Government workers stare at screens all day.
3. **Mobile responsive** but desktop-first. This is a workstation tool.
4. **Accessible** — WCAG 2.1 AA compliance. Government requirement.
5. **Fast.** No loading spinners that take 5 seconds. SSR where possible.
6. **Secure by default.** HTTPS only, secure headers, CSRF protection, rate limiting.

## Branding
- **Name:** IRS SkyShield  
- **Tagline:** "AI-Assisted Safeguards Research & SCSEM Stewardship"
- **Colors:** Deep navy (#1a237e), accent blue (#42a5f5), white, subtle grays
- **Logo:** Shield icon with a subtle AI/circuit motif (can be placeholder for now)
- **No "Sky Solutions" or "Galang AI" branding** — this is a neutral product

## Security Requirements
- All data encrypted at rest and in transit
- API key (Bifrost virtual key) stored as environment variable, never in code
- Rate limiting on AI agent (prevent abuse)
- Session timeout after 30 minutes of inactivity
- Password requirements: 12+ chars, complexity rules
- CSRF tokens on all forms
- Content Security Policy headers
- No FTI/PII stored in the application EVER
- CIS credentials and licensed artifacts are provisioned and retained only through approved operational controls, never source control
- Candidate SCSEM exports are visibly non-release artifacts until separate Office of Safeguards quality-control and publication approval is recorded

## Environment Variables Needed
```
DATABASE_URL=postgresql://...
BIFROST_API_KEY=sk-bf-... (Bifrost virtual key)
BIFROST_BASE_URL=http://192.168.16.104:8080/v1
BIFROST_MODEL=azure/claude-sonnet-4-6
BIFROST_EMBEDDING_MODEL=azure/text-embedding-ada-002
NEXTAUTH_SECRET=...
NEXTAUTH_URL=...
BRAVE_SEARCH_API_KEY=... (for web search, if available)
```

## File Structure
```
/data/pub1075/          — Publication 1075 full text (for AI context)
/data/scsem-manifest.json — Pinned official IRS SCSEM source metadata and hashes
/data/scsems/current/   — Flat, hash-pinned corpus of all 58 current IRS SCSEM XLSX files
/src/app/               — Next.js App Router pages
/src/components/        — Shared UI components
/src/lib/               — Utilities, AI client, PII detection, etc.
/prisma/                — Database schema
/public/                — Static assets
```

## Deployment
- Docker container with multi-stage build
- PostgreSQL as separate service (or Coolify-managed)
- Environment variables via Coolify
- Health check endpoint at /api/health

## Phase 1 (MVP — Build Tonight)
Focus on getting these working:
1. ✅ Next.js project setup with Tailwind + shadcn/ui
2. ✅ Auth (NextAuth with credentials provider + invite system)
3. ✅ AI Agent chat interface with full Pub 1075 context
4. ✅ FTI/PII detection guardrails on all AI inputs
5. ✅ Steward-only SCSEM source verification, candidate update review, and candidate XLSX export
6. ✅ Basic incident tracker (CRUD)
7. ✅ Audit logging middleware
8. ✅ Dashboard with key metrics
9. ✅ Docker setup for Coolify deployment
10. ✅ Database schema + seed data

## Out of Scope (Phase 2+)
- Automatic CIS Benchmark/CIS-STIG applicability decisions, independent DISA STIG release validation, and automatic SCSEM publication (human review and release governance remain mandatory)
- Email notifications
- PDF export
- API for external integrations
- SSO/SAML
- Advanced analytics/reporting
