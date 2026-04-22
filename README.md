# IRS SkyShield

**AI-Powered IRS Publication 1075 Compliance Platform**

IRS SkyShield helps compliance workers, agencies, and organizations achieve and maintain compliance with IRS Publication 1075 (Tax Information Security Guidelines). Instead of manually searching a 216-page document, users get instant, cited, authoritative guidance from an AI agent backed by the full Publication 1075 text.

## Features

- **AI Compliance Agent** — Ask questions in plain English, get cited answers with specific Pub 1075 section references. Powered by Claude with the full Publication 1075 text in context.
- **FTI/PII Guardrails** — All user inputs are scanned for sensitive data (SSN, EIN, tax return data) before reaching the AI. Blocked messages auto-create incident reports.
- **SCSEM Management** — Browse, search, and track all 58 technology-specific compliance matrices. Mark controls as Compliant/Non-Compliant/N/A/In Progress with notes and evidence.
- **Incident Tracking** — Log and manage FTI/PII exposure incidents with severity levels, status workflows, remediation plans, and activity timelines.
- **Dashboard** — Real-time compliance score, SCSEM coverage donut chart, incidents by severity, quick actions, and recent activity feed.
- **Audit Log** — Every action logged and non-deletable. Searchable, filterable, paginated.
- **User Management** — Role-based access control (Admin, Compliance Officer, Auditor, Viewer) with invitation system.
- **Dark Mode** — Government-professional dark theme by default.

## Tech Stack

- **Framework:** Next.js 16 (App Router, Turbopack)
- **UI:** Tailwind CSS v4 + shadcn/ui components
- **Database:** PostgreSQL + Prisma ORM
- **Auth:** NextAuth.js v5 (JWT sessions, credentials provider)
- **AI:** Anthropic Claude Sonnet 4.6 (1M token context window)
- **Deployment:** Docker (standalone output) → Coolify on Hetzner VPS

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 16+ with the `vector` extension available, or the `pgvector/pgvector:pg16` image
- Anthropic API key (optional for demo mode)

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
ANTHROPIC_API_KEY="sk-ant-..."     # Optional — app runs in demo mode without it
OPENAI_API_KEY="sk-..."            # Optional — enables pgvector embeddings for hybrid RAG
EMBEDDING_MODEL="text-embedding-3-small"
NEXTAUTH_SECRET="generate-a-random-secret-here"
NEXTAUTH_URL="http://localhost:3000"
```

Generate a secret: `openssl rand -base64 32`

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

### 5. Log in

**Demo credentials:**
| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@demo.com` | `SkyShield2026!` |
| Compliance Officer | `compliance@skyshield.gov` | `Compliance123!@#$` |
| Auditor | `auditor@skyshield.gov` | `Auditor123!@#$` |
| Viewer | `viewer@skyshield.gov` | `Viewer123!@#$` |

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
ANTHROPIC_API_KEY=sk-ant-your-key
OPENAI_API_KEY=sk-your-embedding-key
EMBEDDING_MODEL=text-embedding-3-small
NEXTAUTH_SECRET=your-production-secret
NEXTAUTH_URL=https://your-domain.com
```

After deployment, Admin users can manage source documents in **Knowledge Base**. Use the
**Sync Latest Pub 1075** button or `npm run rag:sync:pub1075` to download the official
IRS PDF from IRS.gov, extract page-marked text, and import/embed it. You can also import
NIST standards, SCSEMs, IRS guidance, or internal policy documents with metadata. When
`OPENAI_API_KEY` is configured, imports store embeddings in pgvector; otherwise documents
are still searchable with Postgres full-text and exact section/control matching.

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
| `/api/chat` | GET, POST, PATCH | AI agent conversations |
| `/api/dashboard` | GET | Dashboard metrics |
| `/api/incidents` | GET, POST | Incident CRUD |
| `/api/incidents/[id]` | GET, PUT | Incident detail + updates |
| `/api/scsems` | GET, POST | SCSEM templates + start assessment |
| `/api/scsems/[id]` | GET, PUT | Assessment detail + save controls |
| `/api/audit-log` | GET | Paginated audit logs |
| `/api/users` | GET, POST | User management + invitations |

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
- PII/FTI detection blocks sensitive data before it reaches the AI
- Security headers on all responses (X-Content-Type-Options, X-Frame-Options, etc.)
- Audit logging of all user actions
- Role-based access control with 4 permission levels
- Passwords hashed with bcrypt (12 rounds)

## Architecture Decisions

- **Server Components by default** — Pages use React Server Components for data fetching, keeping the client bundle small
- **PII detection runs server-side** — Sensitive data patterns are caught before any external API call
- **Audit logging is non-blocking** — Failed audit writes don't break primary workflows
- **Demo mode** — Works without an Anthropic API key by returning sample responses
- **Standalone Docker output** — Optimized for containerized deployment
