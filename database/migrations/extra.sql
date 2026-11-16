SELECT
    tenant_id,
    idempotency_key,
    operation_type,
    request_hash,
    resource_id
FROM idempotency_keysCREATE TABLE idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL
        REFERENCES tenants(id) ON DELETE CASCADE,

    idempotency_key VARCHAR(255) NOT NULL,

    operation_type VARCHAR(20) NOT NULL
        CHECK (operation_type IN ('single', 'bulk')),

    request_hash CHAR(64) NOT NULL,

    resource_id UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT idempotency_keys_tenant_key_unique
        UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL
        REFERENCES tenants(id) ON DELETE CASCADE,

    idempotency_key VARCHAR(255) NOT NULL,

    operation_type VARCHAR(20) NOT NULL
        CHECK (operation_type IN ('single', 'bulk')),

    request_hash CHAR(64) NOT NULL,

    resource_id UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT idempotency_keys_tenant_key_unique
        UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL
        REFERENCES tenants(id) ON DELETE CASCADE,

    idempotency_key VARCHAR(255) NOT NULL,

    operation_type VARCHAR(20) NOT NULL
        CHECK (operation_type IN ('single', 'bulk')),

    request_hash CHAR(64) NOT NULL,

    resource_id UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT idempotency_keys_tenant_key_unique
        UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL
        REFERENCES tenants(id) ON DELETE CASCADE,

    idempotency_key VARCHAR(255) NOT NULL,

    operation_type VARCHAR(20) NOT NULL
        CHECK (operation_type IN ('single', 'bulk')),

    request_hash CHAR(64) NOT NULL,

    resource_id UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT idempotency_keys_tenant_key_unique
        UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idempotency_keys_tenant_created_idx
ON idempotency_keys (tenant_id, created_at DESC);

SELECT *
FROM idempotency_keys;

INSERT INTO idempotency_keys (
    tenant_id,
    idempotency_key,
    operation_type,
    request_hash,
    resource_id
)
SELECT
    tenant_id,
    idempotency_key,
    'single',
    request_hash,
    notification_id
FROM idempotency_records

UNION ALL

SELECT
    tenant_id,
    idempotency_key,
    'bulk',
    request_hash,
    id
FROM bulk_requests;

SELECT
    tenant_id,
    idempotency_key,
    operation_type,
    resource_id
FROM idempotency_keys;