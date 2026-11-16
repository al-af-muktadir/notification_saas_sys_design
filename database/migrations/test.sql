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
ALTER TABLE tenant_api_keys
ADD COLUMN allowed_ips TEXT[] NOT NULL DEFAULT '{}';


UPDATE tenant_api_keys
SET allowed_ips = ARRAY['103.137.228.155']
WHERE name = 'Production';

UPDATE tenant_api_keys
SET allowed_ips = ARRAY['203.0.113.10']
WHERE name = 'Production';

UPDATE tenant_api_keys
SET allowed_ips = '{}'
WHERE name = 'Production';


UPDATE tenant_api_keys
SET allowed_ips = ARRAY['203.0.113.10']
WHERE id = 'ec87923c-bdf7-4596-89b8-039f2b553e4d';

ALTER TABLE tenant_api_keys
ADD COLUMN permissions TEXT[] NOT NULL DEFAULT '{}';

UPDATE tenant_api_keys
SET permissions = ARRAY['keys:manage']
WHERE id = 'ec87923c-bdf7-4596-89b8-039f2b553e4d';

UPDATE tenant_api_keys
SET permissions = ARRAY['keys:manage']
WHERE id = 'ec87923c-bdf7-4596-89b8-039f2b553e4d';

SELECT id, name, permissions
FROM tenant_api_keys;

SELECT id, name, revoked_at
FROM tenant_api_keys
WHERE id = '35464d77-b7ba-4b3c-abe9-235c21937e34';


SELECT
    table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'tenant_id'
ORDER BY table_name;

SELECT
    current_user,
    rolsuper,
    rolbypassrls
FROM pg_roles
WHERE rolname = current_user;


SELECT
    table_name,
    column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'tenant_id'
ORDER BY table_name;


SELECT
    table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
      'notifications',
      'idempotency_records',
      'bulk_requests',
      'tenant_api_keys',
      'outbox_events',
      'provider_webhook_events'
  )
ORDER BY table_name, ordinal_position;




-- 1. Enable RLS on tenant-owned tables

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_api_keys ENABLE ROW LEVEL SECURITY;


-- 2. Notifications policy

DROP POLICY IF EXISTS tenant_isolation ON notifications;

CREATE POLICY tenant_isolation
ON notifications
FOR ALL
USING (
    tenant_id = NULLIF(
        current_setting('app.current_tenant_id', true),
        ''
    )::uuid
)
WITH CHECK (
    tenant_id = NULLIF(
        current_setting('app.current_tenant_id', true),
        ''
    )::uuid
);


-- 3. Idempotency records policy

DROP POLICY IF EXISTS tenant_isolation ON idempotency_records;

CREATE POLICY tenant_isolation
ON idempotency_records
FOR ALL
USING (
    tenant_id = NULLIF(
        current_setting('app.current_tenant_id', true),
        ''
    )::uuid
)
WITH CHECK (
    tenant_id = NULLIF(
        current_setting('app.current_tenant_id', true),
        ''
    )::uuid
);


-- 4. Bulk requests policy

DROP POLICY IF EXISTS tenant_isolation ON bulk_requests;

CREATE POLICY tenant_isolation
ON bulk_requests
FOR ALL
USING (
    tenant_id = NULLIF(
        current_setting('app.current_tenant_id', true),
        ''
    )::uuid
)
WITH CHECK (
    tenant_id = NULLIF(
        current_setting('app.current_tenant_id', true),
        ''
    )::uuid
);


-- 5. API keys policy

DROP POLICY IF EXISTS tenant_isolation ON tenant_api_keys;

CREATE POLICY tenant_isolation
ON tenant_api_keys
FOR ALL
USING (
    tenant_id = NULLIF(
        current_setting('app.current_tenant_id', true),
        ''
    )::uuid
)
WITH CHECK (
    tenant_id = NULLIF(
        current_setting('app.current_tenant_id', true),
        ''
    )::uuid
);


SELECT
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename;


SELECT
    relname AS table_name,
    relrowsecurity AS rls_enabled,
    relforcerowsecurity AS force_rls
FROM pg_class
WHERE relname IN (
    'notifications',
    'idempotency_records',
    'bulk_requests',
    'tenant_api_keys'
);

SELECT
    c.relname AS table_name,
    c.relrowsecurity AS rls_enabled,
    c.relforcerowsecurity AS force_rls,
    p.policyname
FROM pg_class c
JOIN pg_namespace n
    ON n.oid = c.relnamespace
LEFT JOIN pg_policies p
    ON p.schemaname = n.nspname
   AND p.tablename = c.relname
WHERE n.nspname = 'public'
  AND c.relname IN (
      'notifications',
      'idempotency_records',
      'bulk_requests',
      'tenant_api_keys'
  )
ORDER BY c.relname;


ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bulk_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_api_keys ENABLE ROW LEVEL SECURITY;



DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'notifications',
        'idempotency_records',
        'bulk_requests'
    ]
    LOOP
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I
             FOR ALL
             USING (
                tenant_id = NULLIF(
                    current_setting(''app.current_tenant_id'', true),
                    ''''
                )::uuid
             )
             WITH CHECK (
                tenant_id = NULLIF(
                    current_setting(''app.current_tenant_id'', true),
                    ''''
                )::uuid
             )',
            tbl
        );
    END LOOP;
END $$;



SELECT
    c.relname AS table_name,
    c.relrowsecurity AS rls_enabled,
    p.policyname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policies p
    ON p.schemaname = n.nspname
   AND p.tablename = c.relname
WHERE n.nspname = 'public'
  AND c.relname IN (
      'notifications',
      'idempotency_records',
      'bulk_requests',
      'tenant_api_keys'
  )
ORDER BY c.relname;


SELECT
    table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
      'outbox_events',
      'provider_webhook_events'
  )
ORDER BY table_name, ordinal_position;