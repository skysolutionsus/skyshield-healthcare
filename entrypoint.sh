#!/bin/sh
set -e

echo "=== SkyShield Entrypoint ==="
echo "DATABASE_URL: ${DATABASE_URL}"

# Run Prisma db push to ensure schema is up to date
echo "Running prisma db push..."
npx prisma db push --skip-generate 2>&1 || echo "Warning: prisma db push encountered an issue"

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
