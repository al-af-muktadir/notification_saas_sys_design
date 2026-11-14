import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

interface BrevoPayload {
  event?: string;
  reason?: string;
  'message-id'?: string;
}

interface StoredEvent {
  id: string;
  event_type: string;
  provider_message_id: string;
  payload: BrevoPayload;
}

@Injectable()
export class BrevoWebhookProcessorService {
  async process(
    client: PoolClient,
    eventId: string,
  ): Promise<'matched' | 'unmatched' | 'already_processed'> {
    // 1. Load and lock the webhook event.
    const eventResult = await client.query<StoredEvent>(
      `
      SELECT id, event_type, provider_message_id, payload
      FROM provider_webhook_events
      WHERE id = $1
        AND processed_at IS NULL
      FOR UPDATE
      `,
      [eventId],
    );

    if (eventResult.rows.length === 0) {
      return 'already_processed';
    }

    const event = eventResult.rows[0];

    // 2. Normalize the event name.
    const normalizedEvent = (event.payload.event ?? event.event_type)
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/-/g, '_');

    const supportedEvents = [
      'request',
      'sent',
      'delivered',
      'hard_bounce',
      'soft_bounce',
      'blocked',
      'invalid_email',
      'invalid',
      'spam',
      'deferred',
      'error',
    ];

    // Unknown events are retained for auditing but not retried forever.
    if (!supportedEvents.includes(normalizedEvent)) {
      await client.query(
        `
        UPDATE provider_webhook_events
        SET processed_at = NOW()
        WHERE id = $1
        `,
        [eventId],
      );

      return 'already_processed';
    }

    // 3. Find the corresponding notification.
    const notificationResult = await client.query<{ id: string }>(
      `
      SELECT id
      FROM notifications
      WHERE provider_message_id = $1
      FOR UPDATE
      `,
      [event.provider_message_id],
    );

    // Not found: keep processed_at NULL.
    // Reconciliation will try again later.
    if (notificationResult.rows.length === 0) {
      return 'unmatched';
    }

    const notificationId = notificationResult.rows[0].id;

    // 4. Determine whether this is a permanent failure.
    const permanentFailures = [
      'hard_bounce',
      'blocked',
      'invalid_email',
      'invalid',
      'spam',
    ];

    const isPermanentFailure = permanentFailures.includes(normalizedEvent);

    const errorMessage = event.payload.reason ?? normalizedEvent;

    // 5. Update notification status.
    await client.query(
      `
      UPDATE notifications
      SET
        status = CASE
          WHEN status IN ('delivered', 'cancelled') THEN status
          WHEN $2 = 'delivered' THEN 'delivered'
          WHEN $3 = TRUE THEN 'failed'
          ELSE status
        END,

        last_error = CASE
          WHEN status IN ('delivered', 'cancelled')
            OR $2 = 'delivered'
            THEN NULL
          WHEN $3 = TRUE
            OR $2 IN ('soft_bounce', 'deferred', 'error')
            THEN $4
          ELSE last_error
        END,

        locked_by = CASE
          WHEN $2 = 'delivered' OR $3 = TRUE THEN NULL
          ELSE locked_by
        END,

        locked_until = CASE
          WHEN $2 = 'delivered' OR $3 = TRUE THEN NULL
          ELSE locked_until
        END

      WHERE id = $1
      `,
      [notificationId, normalizedEvent, isPermanentFailure, errorMessage],
    );

    // 6. Mark event processed in the SAME transaction.
    await client.query(
      `
      UPDATE provider_webhook_events
      SET processed_at = NOW()
      WHERE id = $1
      `,
      [eventId],
    );

    return 'matched';
  }
}
