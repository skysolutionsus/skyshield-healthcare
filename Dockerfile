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

# Pre-compile tsx so lightweight startup scripts can run in production.
RUN npx tsx --tsconfig tsconfig.json -e "console.log('tsx works')" 2>/dev/null || true

# Stage 3: Production
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache poppler-utils

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
RUN mkdir -p /var/lib/skyshield && chown -R nextjs:nodejs /var/lib/skyshield

# Install production dependencies only for the final image. The builder stage
# still uses dev dependencies for the Next.js/TypeScript build, but exporting the
# full build-time node_modules layer can make Coolify deployments fail on small
# hosts during image export.
COPY package.json package-lock.json* ./
COPY --from=builder /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder /app/prisma/migrations ./prisma/migrations
RUN npm ci --omit=dev --ignore-scripts \
  && DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public" npx prisma generate \
  && npm cache clean --force

# Copy all necessary files
COPY --from=builder /app/data ./data
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next

# Copy only the source files needed by the runtime validator and one-shot
# administrator bootstrap command.
COPY --from=builder /app/src/lib/runtime-config.ts ./src/lib/runtime-config.ts
COPY --from=builder /app/src/lib/password-policy.ts ./src/lib/password-policy.ts
COPY --from=builder /app/scripts/validate-runtime-config.ts ./scripts/validate-runtime-config.ts
COPY --from=builder /app/scripts/bootstrap-admin.ts ./scripts/bootstrap-admin.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Copy entrypoint script
COPY --from=builder /app/entrypoint.sh ./entrypoint.sh
USER root
RUN chmod +x /app/entrypoint.sh
USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV SKYSHIELD_RUNTIME_DATA_DIR="/var/lib/skyshield"

# The updater is upload-driven now, so startup no longer parses all bundled
# SCSEM workbooks before the app can become healthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
