-- Restore the persisted SkyShield chat model after the temporary Bifrost fallback.
-- When no persisted setting exists, the application already falls back to the
-- BIFROST_MODEL environment variable, which is configured for Sonnet 4.6.
UPDATE "SystemSetting"
SET
    "value" = 'azure/claude-sonnet-4-6',
    "updatedBy" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'llm_model';
