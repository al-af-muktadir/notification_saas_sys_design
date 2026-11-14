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
import { BrevoWebhookProcessorService } from './brevo-webhook-processor.service.js';

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
  constructor(
    private readonly database: DatabaseService,
    private readonly processor: BrevoWebhookProcessorService,
  ) {}

  @Post()
  @HttpCode(200)
  async handleWebhook(
    @Headers('x-brevo-webhook-key') suppliedKey: string,
    @Body() body: BrevoWebhookPayload,
  ) {
    // 1. Authenticate webhook.
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

    // 4. Generate deduplication key.
    const eventTimestamp = body.ts_event ?? body.ts ?? body.date ?? '';

    const eventKey = createHash('sha256')
      .update(
        ['brevo', messageId, normalizedEvent, String(eventTimestamp)].join('|'),
      )
      .digest('hex');

    // 5. Store and process in one transaction.
    return this.database.transaction(async (client) => {
      const inserted = await client.query(
        `
        INSERT INTO provider_webhook_events (
          provider,
          event_key,
          provider_message_id,
          event_type,
          payload
        )
        VALUES ('brevo', $1, $2, $3, $4)
        ON CONFLICT (provider, event_key) DO NOTHING
        RETURNING id
        `,
        [eventKey, messageId, normalizedEvent, JSON.stringify(body)],
      );

      let eventRecordId: string;

      if (inserted.rows.length === 0) {
        // Event already exists. Check whether it was processed.
        const existing = await client.query(
          `
          SELECT id, processed_at
          FROM provider_webhook_events
          WHERE provider = 'brevo'
            AND event_key = $1
          FOR UPDATE
          `,
          [eventKey],
        );

        if (existing.rows.length === 0) {
          return {
            received: true,
            duplicate: true,
          };
        }

        if (existing.rows[0].processed_at !== null) {
          return {
            received: true,
            duplicate: true,
          };
        }

        // Existing but unprocessed event.
        eventRecordId = existing.rows[0].id;
      } else {
        eventRecordId = inserted.rows[0].id;
      }

      // 6. Shared processing logic.
      const outcome = await this.processor.process(client, eventRecordId);

      return {
        received: true,
        matched: outcome === 'matched',
        duplicate: outcome === 'already_processed',
        event: normalizedEvent,
      };
    });
  }
}
