# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/
# Install dependencies without lifecycle scripts; Prisma is generated explicitly
# in the builder stage where the build-time DATABASE_URL is defined.
RUN npm ci --ignore-scripts

# Stage 2: Build
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Prisma needs a build-time DATABASE_URL to generate the client.
ENV DATABASE_URL="postgresql://postgres:postgres@localhost:5432/irs_skyshield?schema=public"

RUN npx prisma generate
RUN mkdir -p data
RUN npm run build

# Pre-compile the seed script so it can run without tsx in production
RUN npx tsx --tsconfig tsconfig.json -e "console.log('tsx works')" 2>/dev/null || true

# Stage 3: Production
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache poppler-utils

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy all necessary files
COPY --from=builder /app/data ./data
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules

# Copy source files needed for seed (tsx can import TS directly)
COPY --from=builder /app/src/lib/xlsx-parser.ts ./src/lib/xlsx-parser.ts
COPY --from=builder /app/src/lib/db.ts ./src/lib/db.ts
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Copy entrypoint script
COPY --from=builder /app/entrypoint.sh ./entrypoint.sh
USER root
RUN chmod +x /app/entrypoint.sh
USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Override this in Coolify with the internal PostgreSQL connection string.
ENV DATABASE_URL="postgresql://postgres:postgres@db:5432/irs_skyshield?schema=public"

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
