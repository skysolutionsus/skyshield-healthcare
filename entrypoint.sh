#!/bin/sh
set -e

echo "=== SkyShield Entrypoint ==="
echo "DATABASE_URL: configured"

echo "Validating runtime authentication configuration..."
npx --no-install tsx scripts/validate-runtime-config.ts

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

echo "Starting Next.js server..."
exec npm start
