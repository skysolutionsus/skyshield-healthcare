# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN npm ci

# Stage 2: Build
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# SQLite needs a dummy DATABASE_URL at build time for Prisma to generate
ENV DATABASE_URL="file:./data/db.sqlite"

RUN npx prisma generate
RUN mkdir -p data
RUN npm run build

# Stage 3: Production
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy all necessary files
COPY --from=builder /app/data ./data
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules

# Create data directory for SQLite and set ownership
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

# Copy assets needed for seed (license.xml, SCSEM XLSX files)
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/src/lib/xlsx-parser.ts ./src/lib/xlsx-parser.ts

# Copy entrypoint script
COPY --from=builder /app/entrypoint.sh ./entrypoint.sh
USER root
RUN chmod +x /app/entrypoint.sh
USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Default SQLite path - can be overridden via env var
ENV DATABASE_URL="file:/app/data/db.sqlite"

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
