#!/bin/sh
set -e

echo "=== SkyShield Start ==="

# Ensure schema is up to date
echo "Running prisma db push..."
npx prisma db push --skip-generate 2>&1 || echo "Warning: prisma db push issue"

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
