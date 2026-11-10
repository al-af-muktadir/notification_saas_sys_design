CREATE TABLE IF NOT EXISTS provider_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(30) NOT NULL,
    event_key TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    UNIQUE (provider, event_key)
);

CREATE INDEX IF NOT EXISTS idx_provider_webhook_unprocessed
ON provider_webhook_events (received_at)
WHERE processed_at IS NULL;

SELECT
    provider,
    event_type,
    provider_message_id,
    received_at,
    processed_at
FROM provider_webhook_events
ORDER BY received_at DESC
LIMIT 10;