#!/bin/sh
set -e

echo "=== SkyShield Start ==="

# Ensure schema is up to date using committed migrations.
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

# Check if SCSEM data needs seeding
# Force re-seed if: sheets are missing OR sheets lack rawData (v3 parser stores all sheet data)
NEEDS_SEED=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const sheets = await p.sCSEMSheet.count();
    if (sheets === 0) { console.log('yes'); return; }
    const withRaw = await p.sCSEMSheet.count({ where: { rawData: { not: null } } });
    if (withRaw === 0) { console.log('yes'); return; }
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
