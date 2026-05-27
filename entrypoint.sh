#!/bin/sh
set -e

echo "=== SkyShield Entrypoint ==="
echo "DATABASE_URL: configured"

# Apply committed database migrations, including pgvector extension setup.
echo "Running prisma migrate deploy..."
attempt=1
until npx prisma migrate deploy; do
  if [ "$attempt" -ge 10 ]; then
    echo "ERROR: prisma migrate deploy failed after ${attempt} attempts"
    exit 1
  fi
  attempt=$((attempt + 1))
  echo "Database not ready or migration failed. Retrying in 5 seconds (${attempt}/10)..."
  sleep 5
done

if [ "${SKYSHIELD_SYNC_PRODUCTION_USERS:-true}" != "false" ]; then
  echo "Syncing baseline organization and users..."
  npx tsx scripts/sync-production-users.ts 2>&1 || echo "Warning: user sync encountered an issue"
else
  echo "Skipping baseline user sync."
fi

if [ "${SKYSHIELD_RUN_LEGACY_SCSEM_SEED:-false}" = "true" ]; then
  echo "Running legacy SCSEM seed. This parses all bundled SCSEM workbooks and may take several minutes..."
  NODE_OPTIONS="--max-old-space-size=4096" npx tsx prisma/seed.ts 2>&1 || echo "Warning: legacy seed encountered an issue"
fi

echo "Starting Next.js server..."
exec npm start
