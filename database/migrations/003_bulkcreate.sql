CREATE TABLE bulk_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL REFERENCES tenants(id),

    idempotency_key VARCHAR(255) NOT NULL,
    request_hash CHAR(64) NOT NULL,

    accepted_count INTEGER NOT NULL DEFAULT 0,
    rejected_count INTEGER NOT NULL DEFAULT 0,

    response JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',

    CONSTRAINT bulk_request_idempotency_unique
        UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE notifications
ADD COLUMN bulk_request_id UUID
REFERENCES bulk_requests(id);

CREATE INDEX idx_notifications_bulk_request
ON notifications (bulk_request_id)
WHERE bulk_request_id IS NOT NULL;