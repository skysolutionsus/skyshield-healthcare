#!/bin/sh
set -e

echo "=== SkyShield Entrypoint ==="

# Run Prisma db push to ensure schema is up to date
echo "Running prisma db push..."
npx prisma db push --skip-generate 2>&1 || echo "prisma db push failed (may already be in sync)"

# Check if seed data exists by looking for SCSEMSheet records
SHEET_COUNT=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.sCSEMSheet.count().then(c => { console.log(c); p.\$disconnect(); }).catch(() => { console.log(0); p.\$disconnect(); });
" 2>/dev/null || echo "0")

if [ "$SHEET_COUNT" = "0" ] || [ "$SHEET_COUNT" = "" ]; then
  echo "No SCSEM sheet data found. Running seed..."
  NODE_OPTIONS="--max-old-space-size=4096" npx prisma db seed 2>&1 || echo "Seed failed, app will start anyway"
  echo "Seed complete."
else
  echo "Database already seeded ($SHEET_COUNT sheets found). Skipping seed."
fi

echo "Starting Next.js..."
exec npm start
