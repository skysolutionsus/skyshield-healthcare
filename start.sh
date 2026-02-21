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

# Check if SCSEM control data needs seeding
# Force re-seed if: no controls, or controls exist but missing new fields (stale seed)
NEEDS_SEED=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const total = await p.sCSEMControl.count();
    if (total < 10) { console.log('yes'); return; }
    // Check if controls have the new criticality field populated (added in XLSX completeness update)
    const withCrit = await p.sCSEMControl.count({ where: { criticality: { not: null } } });
    if (withCrit === 0) { console.log('yes'); return; } // stale seed
    console.log('no');
  } catch(e) { console.log('yes'); }
  finally { await p.\$disconnect(); }
})();
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
