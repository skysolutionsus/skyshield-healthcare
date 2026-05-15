# IRS SkyShield — Product Specification

## Overview
IRS SkyShield is an AI-powered web application that helps IRS Office of Safeguards compliance workers, agencies, and organizations achieve and maintain compliance with **IRS Publication 1075** (Tax Information Security Guidelines). Instead of manually searching a 216-page document, users get instant, cited, authoritative guidance from an AI agent backed by the full Publication 1075 text.

## Core Value Proposition
- **Instant Pub 1075 guidance** — ask questions in plain English, get cited answers with section references
- **SCSEM management** — browse, search, and track 58 technology-specific compliance matrices
- **Incident tracking** — log and manage FTI/PII exposure incidents with remediation workflows
- **FTI/PII guardrails** — the app itself rejects any FTI/PII input, creating incident reports if users attempt to submit sensitive data
- **Web search integration** — cross-reference Pub 1075 requirements with real-world technologies (CrowdStrike, Windows, etc.)
- **CIS Benchmark tracking** — monitor when CIS benchmarks update and flag SCSEM deltas

## Architecture

### Tech Stack
- **Framework:** Next.js 15 (App Router)
- **UI:** Tailwind CSS + shadcn/ui components
- **Database:** PostgreSQL (for multi-tenant data, audit logs, incidents)
- **ORM:** Prisma
- **Auth:** NextAuth.js v5 with role-based access (Admin, Compliance Officer, Auditor, Viewer)
- **AI:** Claude Sonnet 4.6 via Bifrost chat completions on Microsoft Foundry
- **Search:** Brave Search API or similar for web augmentation
- **Deployment:** Docker → Coolify on Hetzner VPS

### Multi-Tenant Architecture
- Organizations sign up and get isolated workspaces
- Users belong to organizations with role-based permissions
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
- **Compliance Score** — overall organization compliance percentage based on completed SCSEM assessments
- **Open Incidents** — count + severity breakdown (Critical/High/Medium/Low)
- **Recent Activity** — audit log feed (last 20 actions)
- **SCSEM Status** — pie chart showing assessed vs unassessed technologies
- **Upcoming Deadlines** — safeguards review dates, corrective action deadlines
- **Quick Actions** — "Ask Agent", "Report Incident", "Start SCSEM Assessment"

### 3. SCSEM Management
Browse, assess, and track all 58 SCSEM templates.

**Features:**
- **SCSEM Library** — organized by category (Application, Database, Network, Windows, UNIX/Linux, etc.)
- **Assessment Workflow** — for each SCSEM:
  - View all controls/requirements
  - Mark each control as: Compliant / Non-Compliant / Not Applicable / In Progress
  - Add notes, evidence links, responsible party
  - Track remediation status for non-compliant items
  - Calculate compliance percentage
- **CIS Benchmark Tracking:**
  - Store current CIS Benchmark version for each SCSEM technology
  - Periodically check (or manually trigger) CIS website for updates
  - When a new CIS Benchmark version is detected, flag the corresponding SCSEM as "Review Needed"
  - Show diff summary of what changed
- **Export** — export assessment results as Excel/PDF for safeguards reviews

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
- SCSEM assessment changes
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
- Assign roles: Admin, Compliance Officer, Auditor, Viewer
- Role permissions:
  - **Admin:** Full access, user management, org settings
  - **Compliance Officer:** Full access except user management
  - **Auditor:** Read-only access to everything, can add comments
  - **Viewer:** Dashboard + read-only SCSEM/incidents
- Deactivate/remove users
- View user activity

### 7. Organization Settings
- Organization name, logo
- Notification preferences
- SCSEM assessment schedule
- Custom incident categories
- API key management (for future integrations)

## Data Model (Key Entities)

```
Organization
  - id, name, slug, logo, createdAt

User
  - id, email, name, role, organizationId, lastLogin, createdAt

Conversation
  - id, userId, title, createdAt, bookmarked

Message
  - id, conversationId, role (user/assistant), content, citations[], createdAt

SCSEMTemplate
  - id, name, category, version, effectiveDate, cisVersion, filePath

SCSEMAssessment
  - id, templateId, organizationId, assessedBy, status, complianceScore, createdAt

SCSEMControlResult
  - id, assessmentId, controlId, status (compliant/non-compliant/na/in-progress), notes, evidence, assignedTo

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
- **Tagline:** "AI-Powered Publication 1075 Compliance"
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
/data/scsems/           — All 58 SCSEM xlsx files organized by category
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
5. ✅ SCSEM library browser (read-only, organized by category)
6. ✅ Basic incident tracker (CRUD)
7. ✅ Audit logging middleware
8. ✅ Dashboard with key metrics
9. ✅ Docker setup for Coolify deployment
10. ✅ Database schema + seed data

## Out of Scope (Phase 2+)
- CIS Benchmark auto-checking (manual for now)
- Email notifications
- PDF export
- API for external integrations
- SSO/SAML
- Advanced analytics/reporting
