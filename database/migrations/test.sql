SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'tenants'
ORDER BY ordinal_position;

SELECT id, name
FROM tenants;

CREATE TABLE tenant_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL
        REFERENCES tenants(id) ON DELETE CASCADE,

    name VARCHAR(100) NOT NULL,

    key_prefix VARCHAR(20) NOT NULL,

    key_hash CHAR(64) NOT NULL UNIQUE,

    last_used_at TIMESTAMPTZ,

    expires_at TIMESTAMPTZ,

    revoked_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Find API keys belonging to a tenant
CREATE INDEX idx_tenant_api_keys_tenant
ON tenant_api_keys (tenant_id);

-- Find active keys by prefix
CREATE INDEX idx_tenant_api_keys_active
ON tenant_api_keys (key_prefix)
WHERE revoked_at IS NULL;


SELECT id, tenant_id, name, key_prefix, created_at
FROM tenant_api_keys
WHERE tenant_id = '85825682-b255-46de-84fb-b4accf7b76be';