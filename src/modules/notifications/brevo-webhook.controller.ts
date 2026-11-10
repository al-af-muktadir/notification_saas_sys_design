import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';

import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../../database/database.service.js';

interface BrevoWebhookPayload {
  id?: number | string;
  uuid?: string;
  event?: string;
  email?: string;
  'message-id'?: string;
  ts?: number;
  ts_event?: number;
  ts_epoch?: number;
  date?: string;
  reason?: string;
  subject?: string;
  sending_ip?: string;
  template_id?: number;
}

@Controller('webhooks/brevo')
export class BrevoWebhookController {
  constructor(private readonly database: DatabaseService) {}

  @Post()
  @HttpCode(200)
  async handleWebhook(
    @Headers('x-brevo-webhook-key') suppliedKey: string,
    @Body() body: BrevoWebhookPayload,
  ) {
    // 1. Authenticate the webhook.
    const expectedKey = process.env.BREVO_WEBHOOK_KEY;

    const supplied = Buffer.from(suppliedKey ?? '');
    const expected = Buffer.from(expectedKey ?? '');

    if (
      !expectedKey ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new UnauthorizedException('Invalid webhook authentication');
    }

    // 2. Validate payload.
    const event = body.event?.trim();
    const messageId = body['message-id']?.trim();

    if (!event || !messageId) {
      throw new BadRequestException('Missing event or message-id');
    }

    // 3. Normalize event name.
    const normalizedEvent = event
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/-/g, '_');

    // 4. Generate an event-specific deduplication key.
    // IMPORTANT: body.id is the webhook ID, NOT the event ID.
    const eventTimestamp = body.ts_event ?? body.ts ?? body.date ?? '';

    const eventKey = createHash('sha256')
      .update(
        ['brevo', messageId, normalizedEvent, String(eventTimestamp)].join('|'),
      )
      .digest('hex');

    const permanentFailures = [
      'hard_bounce',
      'blocked',
      'invalid_email',
      'invalid',
      'spam',
    ];

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

    return this.database.transaction(async (client) => {
      // 5. Insert event, deduplicating repeated callbacks.
      const inserted = await client.query(
        `INSERT INTO provider_webhook_events
          (provider, event_key, provider_message_id, event_type, payload)
         VALUES ('brevo', $1, $2, $3, $4)
         ON CONFLICT (provider, event_key) DO NOTHING
         RETURNING id`,
        [eventKey, messageId, normalizedEvent, JSON.stringify(body)],
      );

      let eventRecordId: string;

      if (inserted.rows.length === 0) {
        // If an earlier delivery left the event unprocessed,
        // allow this repeated callback to finish processing it.
        const existing = await client.query(
          `SELECT id, processed_at
           FROM provider_webhook_events
           WHERE provider = 'brevo'
             AND event_key = $1`,
          [eventKey],
        );

        if (existing.rows.length === 0) {
          return { received: true, duplicate: true };
        }

        if (existing.rows[0].processed_at !== null) {
          return { received: true, duplicate: true };
        }

        eventRecordId = existing.rows[0].id;
      } else {
        eventRecordId = inserted.rows[0].id;
      }

      // 6. Retain unknown events for auditing.
      if (!supportedEvents.includes(normalizedEvent)) {
        await client.query(
          `UPDATE provider_webhook_events
           SET processed_at = NOW()
           WHERE id = $1`,
          [eventRecordId],
        );

        return {
          received: true,
          ignored: true,
          event: normalizedEvent,
        };
      }

      // 7. Find the notification using Brevo's message ID.
      const result = await client.query(
        `SELECT id
         FROM notifications
         WHERE provider_message_id = $1
         LIMIT 1`,
        [messageId],
      );

      if (result.rows.length === 0) {
        // Keep the event unprocessed for reconciliation.
        return {
          received: true,
          matched: false,
          event: normalizedEvent,
        };
      }

      const notificationId = result.rows[0].id;

      const isPermanentFailure = permanentFailures.includes(normalizedEvent);

      // 8. Update notification state.
      await client.query(
        `UPDATE notifications
         SET
           status = CASE
             WHEN status = 'delivered' THEN 'delivered'
             WHEN $2 = 'delivered' THEN 'delivered'
             WHEN $3 = TRUE THEN 'failed'
             ELSE status
           END,

           last_error = CASE
             WHEN status = 'delivered' OR $2 = 'delivered'
               THEN NULL
             WHEN $3 = TRUE
               OR $2 IN ('soft_bounce', 'deferred', 'error')
               THEN $4
             ELSE last_error
           END,

           locked_by = CASE
             WHEN $2 = 'delivered' OR $3 = TRUE
               THEN NULL
             ELSE locked_by
           END,

           locked_until = CASE
             WHEN $2 = 'delivered' OR $3 = TRUE
               THEN NULL
             ELSE locked_until
           END

         WHERE id = $1`,
        [
          notificationId,
          normalizedEvent,
          isPermanentFailure,
          body.reason ?? normalizedEvent,
        ],
      );

      // 9. Mark event processed in the same transaction.
      await client.query(
        `UPDATE provider_webhook_events
         SET processed_at = NOW()
         WHERE id = $1`,
        [eventRecordId],
      );

      return {
        received: true,
        matched: true,
        notificationId,
        event: normalizedEvent,
      };
    });
  }
}
