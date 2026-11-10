import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { CreateNotificationDto } from './dto/create-notification.dto.js';
import { DatabaseService } from '../../database/database.service.js';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly database: DatabaseService) {}

  async create(input: CreateNotificationDto, idempotencyKey: string) {
    if (input.channel !== 'email') {
      throw new BadRequestException(
        'Currently, only email notifications are supported',
      );
    }

    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required.');
    }

    // Same request content produces the same hash.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          channel: input.channel,
          recipient: input.recipient,
          message: input.message,
        }),
      )
      .digest('hex');

    const result = await this.database.transaction(async (client) => {
      // TEMPORARY: use our development tenant.
      const tenantResult = await client.query(
        `SELECT id FROM tenants
         WHERE name = $1
         LIMIT 1`,
        ['Development Tenant'],
      );

      if (tenantResult.rows.length === 0) {
        throw new NotFoundException(
          'Development Tenant not found. Create it first.',
        );
      }

      const tenantId = tenantResult.rows[0].id;

      // 1. Create notification.
      const notificationResult = await client.query(
        `INSERT INTO notifications
          (tenant_id, channel, recipient, message)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tenant_id, channel, recipient, message,
                   status, created_at`,
        [tenantId, input.channel, input.recipient, input.message],
      );

      const notification = notificationResult.rows[0];

      // 2. Try to register the idempotency key.
      const idempotencyResult = await client.query(
        `INSERT INTO idempotency_records
          (tenant_id, notification_id, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, idempotency_key)
         DO NOTHING
         RETURNING id`,
        [tenantId, notification.id, idempotencyKey, requestHash],
      );

      // 3. Key already exists: this is a duplicate request.
      if (idempotencyResult.rows.length === 0) {
        // Remove the notification we just created.
        await client.query(`DELETE FROM notifications WHERE id = $1`, [
          notification.id,
        ]);

        const existingResult = await client.query(
          `SELECT
              n.id, n.tenant_id, n.channel, n.recipient,
              n.message, n.status, n.created_at,
              i.request_hash
           FROM idempotency_records i
           JOIN notifications n ON n.id = i.notification_id
           WHERE i.tenant_id = $1
             AND i.idempotency_key = $2`,
          [tenantId, idempotencyKey],
        );

        const existing = existingResult.rows[0];

        if (!existing) {
          throw new Error('Existing idempotency record not found.');
        }

        // Same key must not be reused for different request content.
        if (existing.request_hash !== requestHash) {
          throw new ConflictException(
            'Idempotency key was already used with a different request.',
          );
        }

        return {
          duplicate: true,
          notification: {
            id: existing.id,
            tenant_id: existing.tenant_id,
            channel: existing.channel,
            recipient: existing.recipient,
            message: existing.message,
            status: existing.status,
            created_at: existing.created_at,
          },
        };
      }

      // 4. Create outbox event in the SAME transaction.
      await client.query(
        `INSERT INTO outbox_events
          (notification_id, routing_key, payload)
         VALUES ($1, $2, $3::jsonb)`,
        [
          notification.id,
          'notifications.email',
          JSON.stringify({
            id: notification.id,
            channel: notification.channel,
            recipient: notification.recipient,
            message: notification.message,
          }),
        ],
      );

      return {
        duplicate: false,
        notification,
      };
    });

    if (result.duplicate) {
      this.logger.warn(
        `Duplicate notification request: ${result.notification.id}`,
      );

      return {
        status: 'accepted',
        message: 'Notification was already accepted.',
        duplicate: true,
        notification: result.notification,
      };
    }

    this.logger.log(
      `Notification ${result.notification.id} saved to PostgreSQL and outbox.`,
    );

    return {
      status: 'accepted',
      message: 'Notification saved and queued for publishing.',
      duplicate: false,
      notification: result.notification,
    };
  }
}
