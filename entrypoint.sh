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

# Check if seed data exists
echo "Checking if database needs seeding..."
NEEDS_SEED=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.sCSEMSheet.count()
  .then(c => { console.log(c === 0 ? 'yes' : 'no'); return p.\$disconnect(); })
  .catch(e => { console.log('yes'); return p.\$disconnect(); });
" 2>/dev/null)

echo "Needs seed: ${NEEDS_SEED}"

if [ "$NEEDS_SEED" = "yes" ] || [ -z "$NEEDS_SEED" ]; then
  echo "Seeding database with SCSEM XLSX data (this may take 2-3 minutes)..."
  NODE_OPTIONS="--max-old-space-size=4096" npx tsx prisma/seed.ts 2>&1 || echo "Warning: Seed encountered an issue"
  echo "Seed complete."
else
  echo "Database already has SCSEM data. Skipping seed."
fi

echo "Starting Next.js server..."
exec npm start
