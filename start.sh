#!/bin/sh
set -e

echo "=== SkyShield Start ==="

# Ensure schema is up to date (--accept-data-loss needed for non-interactive deploys)
echo "Running prisma db push..."
npx prisma db push --accept-data-loss 2>&1
DB_PUSH_STATUS=$?
if [ $DB_PUSH_STATUS -ne 0 ]; then
  echo "ERROR: prisma db push failed with exit code $DB_PUSH_STATUS"
fi

# Check if SCSEM control data actually exists (not just sheets)
NEEDS_SEED=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.sCSEMControl.count()
  .then(c => { console.log(c < 10 ? 'yes' : 'no'); return p.\$disconnect(); })
  .catch(() => { console.log('yes'); return p.\$disconnect(); });
" 2>/dev/null)

echo "Needs seed: ${NEEDS_SEED}"

if [ "$NEEDS_SEED" = "yes" ] || [ -z "$NEEDS_SEED" ]; then
  echo "Seeding database (this takes 2-3 minutes)..."
  NODE_OPTIONS="--max-old-space-size=4096" npx tsx prisma/seed.ts 2>&1 || echo "Warning: Seed issue"
  echo "Seed complete."
else
  echo "Database already seeded. Skipping."
fi

echo "Starting Next.js..."
exec npm start
