
BEGIN;

-- Remove previous schema
DROP TABLE IF EXISTS notification_attempts;
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS idempotency_records;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS tenants;

-- 1. Businesses using our SaaS
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL
);

-- 2. Main notification records
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),

    channel VARCHAR(20) NOT NULL
        CHECK (channel IN ('email', 'sms', 'push', 'in_app')),

    recipient TEXT NOT NULL,
    message TEXT NOT NULL,

    notification_type VARCHAR(20) NOT NULL DEFAULT 'transactional'
        CHECK (notification_type IN ('transactional', 'marketing')),

    status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending',
            'processing',
            'provider_accepted',
            'delivered',
            'retry_scheduled',
            'failed',
            'cancelled'
        )),

    attempts INTEGER NOT NULL DEFAULT 0
        CHECK (attempts >= 0),

    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_attempt_at TIMESTAMPTZ,

    locked_by UUID,
    locked_until TIMESTAMPTZ,

    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT notification_lock_check
        CHECK (
            (status = 'processing') = (locked_by IS NOT NULL)
        ),

    CONSTRAINT notification_lease_check
        CHECK (
            (locked_by IS NULL) = (locked_until IS NULL)
        )
);

-- 3. Prevent duplicate API submissions
CREATE TABLE idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL REFERENCES tenants(id),

    notification_id UUID NOT NULL UNIQUE
        REFERENCES notifications(id),

    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW() + INTERVAL '30 days',

    UNIQUE (tenant_id, idempotency_key)
);

-- 4. Reliable database-to-RabbitMQ publishing
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    notification_id UUID NOT NULL
        REFERENCES notifications(id) ON DELETE RESTRICT,

    routing_key VARCHAR(150) NOT NULL,
    payload JSONB NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'published', 'failed')),

    attempts INTEGER NOT NULL DEFAULT 0,

    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    locked_by UUID,
    locked_until TIMESTAMPTZ,

    last_error TEXT,
    published_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT outbox_lock_check
        CHECK (
            (status = 'processing') = (locked_by IS NOT NULL)
        ),

    CONSTRAINT outbox_lease_check
        CHECK (
            (locked_by IS NULL) = (locked_until IS NULL)
        )
);

COMMIT;
