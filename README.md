# IRS SkyShield

**AI-Powered IRS Publication 1075 Compliance Platform**

IRS SkyShield helps compliance workers, agencies, and organizations achieve and maintain compliance with IRS Publication 1075 (Tax Information Security Guidelines). Instead of manually searching a 216-page document, users get instant, cited, authoritative guidance from an AI agent backed by the full Publication 1075 text.

## Features

- **AI Compliance Agent** — Ask questions in plain English, get cited answers with specific Pub 1075 section references. Powered by Claude through Bifrost with the full Publication 1075 text in context.
- **FTI/PII Guardrails** — All user inputs are scanned for sensitive data (SSN, EIN, tax return data) before reaching the AI. Blocked messages auto-create incident reports.
- **SCSEM Management** — Browse, search, and track all 58 technology-specific compliance matrices. Mark controls as Compliant/Non-Compliant/N/A/In Progress with notes and evidence.
- **Incident Tracking** — Log and manage FTI/PII exposure incidents with severity levels, status workflows, remediation plans, and activity timelines.
- **Dashboard** — Real-time compliance score, SCSEM coverage donut chart, incidents by severity, quick actions, and recent activity feed.
- **Audit Log** — Every action logged and non-deletable. Searchable, filterable, paginated.
- **User Management** — Role-based access control (Admin, Computer Security Review, Compliance Officer, Auditor, Viewer), invitations, and admin account recovery.
- **Multi-Factor Authentication** — Required TOTP authenticator setup after password sign-in, with recovery codes and admin TOTP reset support.
- **Dark Mode** — Government-professional dark theme by default.

## Tech Stack

- **Framework:** Next.js 16 (App Router, Turbopack)
- **UI:** Tailwind CSS v4 + shadcn/ui components
- **Database:** PostgreSQL + Prisma ORM
- **Auth:** NextAuth.js v5 (JWT sessions, credentials provider, required TOTP MFA)
- **AI:** Bifrost chat completions routing to Claude Sonnet 4.6 on Microsoft Foundry
- **Deployment:** Docker (standalone output) → Coolify on Hetzner VPS

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 16+ with the `vector` extension available, or the `pgvector/pgvector:pg16` image
- Bifrost virtual key (optional for demo mode)

### 1. Clone and install

```bash
git clone <repo-url>
cd irs-skyshield
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/irs_skyshield?schema=public"
BIFROST_API_KEY="sk-bf-..."        # Optional — app runs in demo mode without it
BIFROST_BASE_URL="http://192.168.16.104:8080/v1"
BIFROST_MODEL="azure/claude-sonnet-4-6"
BIFROST_EMBEDDING_MODEL="azure/text-embedding-ada-002"
AUTH_SECRET="generate-a-random-secret-here"
NEXTAUTH_URL="http://localhost:3000"
```

Generate a secret: `openssl rand -base64 32`. Keep `AUTH_SECRET` stable across deploys; it protects session cookies and encrypts stored TOTP secrets. `NEXTAUTH_SECRET` is also supported for compatibility, but `AUTH_SECRET` is preferred.

`BIFROST_BASE_URL` may be set to the service root, `/v1`, or the full
`/v1/chat/completions` URL; SkyShield normalizes it internally. Use the private
`192.168.16.104` address from the deployed server.

### 3. Set up the database

```bash
npm run db:migrate    # Apply committed migrations
npm run db:seed       # Seed demo data + SCSEM templates
npm run rag:sync:pub1075 # Download official Pub 1075 from IRS.gov and import/embed it
```

### 4. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 5. Log in and enroll MFA

**Demo credentials:**
| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@demo.com` | `SkyShield2026!` |
| Compliance Officer | `compliance@skyshield.gov` | `Compliance123!@#$` |
| Auditor | `auditor@skyshield.gov` | `Auditor123!@#$` |
| Viewer | `viewer@skyshield.gov` | `Viewer123!@#$` |

After password sign-in, users without MFA are sent to **Settings** to enroll an authenticator app. Scan the QR code with a TOTP app, enter the six-digit code, and save the recovery codes shown after setup.

## Authentication and Account Recovery

- MFA enrollment is mandatory for authenticated users. Until TOTP is enabled, users can only access Settings and the MFA setup API.
- Users manage their own authenticator app and recovery codes from **Settings → Multi-factor authentication**.
- Admins can reset another user’s password from **Settings → Team Members → Actions**. The app generates a temporary password and shows it once to the admin.
- Admins can reset another user’s TOTP from the same Actions area. This clears the user’s TOTP secret and recovery codes; the user is forced through MFA setup again on their next sign-in.
- Admin password resets and TOTP resets are written to the audit log as `USER_PASSWORD_RESET` and `USER_MFA_RESET`.
- Seed/sync passwords can be overridden with `SEED_ADMIN_PASSWORD` and `SEED_COMPUTER_SECURITY_REVIEW_PASSWORD`. Rotate seeded credentials immediately in production.

## Docker Deployment

### Build and run with Docker Compose

```bash
docker compose up -d --build
```

This starts:
- **app** — Next.js on port 3000
- **db** — PostgreSQL 16 + pgvector on port 5432

The app container runs migrations and seeds SCSEM/demo data on startup when needed.

### Production environment variables

Set these in your Docker host / Coolify:

```env
DATABASE_URL=postgresql://postgres:your-password@db:5432/irs_skyshield?schema=public
BIFROST_API_KEY=sk-bf-your-virtual-key
BIFROST_BASE_URL=http://192.168.16.104:8080/v1
BIFROST_MODEL=azure/claude-sonnet-4-6
BIFROST_EMBEDDING_MODEL=azure/text-embedding-ada-002
AUTH_SECRET=your-production-secret
NEXTAUTH_URL=https://your-domain.com
```

After deployment, Admin users can manage source documents in **Knowledge Base**. Use the
**Sync Latest Pub 1075** button or `npm run rag:sync:pub1075` to download the official
IRS PDF from IRS.gov, extract page-marked text, and import/embed it. You can also import
NIST standards, SCSEMs, IRS guidance, or internal policy documents with metadata. When
`BIFROST_API_KEY` is configured, imports store embeddings in pgvector using
`BIFROST_EMBEDDING_MODEL`; otherwise documents are still searchable with Postgres
full-text and exact section/control matching.

## Project Structure

```
├── data/
│   ├── pub1075/           # Publication 1075 full text (AI context)
│   ├── scsem-index.json   # 58 SCSEM template metadata
│   └── scsems/            # XLSX files organized by category
├── prisma/
│   ├── schema.prisma      # Database schema (14 models)
│   └── seed.ts            # Demo data + SCSEM template loader
├── src/
│   ├── app/
│   │   ├── (authenticated)/ # Protected routes
│   │   │   ├── agent/       # AI Chat interface
│   │   │   ├── audit-log/   # Audit log viewer
│   │   │   ├── dashboard/   # Home dashboard
│   │   │   ├── incidents/   # Incident tracker
│   │   │   ├── scsems/      # SCSEM library + assessment
│   │   │   └── settings/    # User management
│   │   ├── api/             # API routes
│   │   └── login/           # Login page
│   ├── components/          # UI components
│   └── lib/                 # Utilities (auth, PII detection, audit)
├── Dockerfile               # Multi-stage production build
├── docker-compose.yml       # PostgreSQL + Next.js services
└── SPEC.md                  # Full product specification
```

## Key Pages

| Route | Description |
|-------|-------------|
| `/login` | Authentication with dark theme branding |
| `/dashboard` | Compliance score, charts, quick actions, activity feed |
| `/agent` | AI chat with Pub 1075 citations and PII blocking |
| `/scsems` | Browse 58 SCSEM templates by category |
| `/scsems/[id]` | Assess controls with status, notes, and evidence |
| `/incidents` | Track security incidents with filters |
| `/incidents/[id]` | Incident detail with status progress and timeline |
| `/audit-log` | Immutable audit trail of all system actions |
| `/settings` | User management and role assignments |

## API Routes

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/health` | GET | Health check (public) |
| `/api/auth/[...nextauth]` | GET, POST | Authentication |
| `/api/mfa` | GET, POST | TOTP enrollment, verification, recovery-code rotation, and self-service disable |
| `/api/chat` | GET, POST, PATCH | AI agent conversations |
| `/api/dashboard` | GET | Dashboard metrics |
| `/api/incidents` | GET, POST | Incident CRUD |
| `/api/incidents/[id]` | GET, PUT | Incident detail + updates |
| `/api/scsems` | GET, POST | SCSEM templates + start assessment |
| `/api/scsems/[id]` | GET, PUT | Assessment detail + save controls |
| `/api/audit-log` | GET | Paginated audit logs |
| `/api/users` | GET, POST | User management, invitations, admin password reset, and admin TOTP reset |

## Scripts

```bash
npm run dev        # Start dev server (Turbopack)
npm run build      # Build for production
npm run start      # Start production server
npm run lint       # Run ESLint
npm run db:generate # Generate Prisma client
npm run db:migrate # Apply committed migrations
npm run db:migrate:dev # Create/apply a migration during local development
npm run db:push    # Push schema directly, dev/prototyping only
npm run db:seed    # Seed demo data
npm run rag:ingest:pub1075 # Import Pub 1075 into knowledge/RAG tables
npm run rag:sync:pub1075 # Download official Pub 1075 from IRS.gov and import/embed it
npm run db:studio  # Open Prisma Studio
```

## Security

- All API routes are authenticated (except `/api/health`)
- JWT sessions with 30-minute expiry
- Required TOTP MFA with encrypted secrets and bcrypt-hashed recovery codes
- Admin account recovery for password resets and TOTP resets, with audit logging
- PII/FTI detection blocks sensitive data before it reaches the AI
- Security headers on all responses (X-Content-Type-Options, X-Frame-Options, etc.)
- Audit logging of all user actions
- Role-based access control with 5 permission levels
- Passwords hashed with bcrypt (12 rounds)

## Architecture Decisions

- **Server Components by default** — Pages use React Server Components for data fetching, keeping the client bundle small
- **PII detection runs server-side** — Sensitive data patterns are caught before any external API call
- **Audit logging is non-blocking** — Failed audit writes don't break primary workflows
- **Demo mode** — Works without a Bifrost virtual key by returning sample responses
- **Standalone Docker output** — Optimized for containerized deployment
