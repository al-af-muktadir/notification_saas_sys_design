CREATE INDEX idx_notifications_expired_leases
ON notifications (locked_until)
WHERE status = 'processing';

CREATE INDEX idx_notifications_due
ON notifications (scheduled_at)
WHERE status = 'pending';

CREATE INDEX idx_outbox_pending
ON outbox_events (available_at, created_at)
WHERE status = 'pending';


INSERT INTO tenants (name)
VALUES ('Development Tenant')
RETURNING id, name;
SELECT id, name
FROM tenants;

SELECT
    n.id AS notification_id,
    n.status AS notification_status,
    o.id AS outbox_id,
    o.status AS outbox_status,
    o.attempts,
    o.published_at,
    o.last_error
FROM notifications n
JOIN outbox_events o
    ON o.notification_id = n.id
ORDER BY o.created_at DESC
LIMIT 5;


SELECT
    id,
    status,
    attempts,
    locked_by,
    locked_until
FROM notifications
ORDER BY created_at DESC
LIMIT 1;


SELECT
    id,
    notification_id,
    status,
    attempts,
    locked_by,
    locked_until,
    last_error,
    published_at
FROM outbox_events
ORDER BY created_at DESC
LIMIT 5;

SELECT
    id,
    notification_id,
    status,
    attempts,
    locked_by,
    locked_until,
    published_at
FROM outbox_events
ORDER BY created_at DESC
LIMIT 1;SELECT
    id,
    notification_id,
    status,
    attempts,
    locked_by,
    locked_until,
    published_at
FROM outbox_events
ORDER BY created_at DESC
LIMIT 1;

SELECT
    id,
    status,
    attempts,
    locked_by,
    locked_until,
    last_error
FROM notifications
WHERE id = 'bbf91c46-6acc-41be-b4f4-e0fa50fab9b5';

SELECT id, status, attempts, locked_by, locked_until, last_error
FROM notifications
ORDER BY created_at DESC
LIMIT 5;

ALTER TABLE notifications
ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
SELECT
    id,
    recipient,
    status,
    attempts,
    provider_message_id,
    last_error
FROM notifications
ORDER BY created_at DESC
LIMIT 5;