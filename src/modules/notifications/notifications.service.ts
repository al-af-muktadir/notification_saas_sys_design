import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { createHash } from 'node:crypto';
import { z } from 'zod';

import type {
  CreateNotificationDto,
  CreateBulkNotificationDto,
} from './dto/create-notification.dto.js';

import { DatabaseService } from '../../database/database.service.js';

export interface BulkRecipientResult {
  index: number;
  recipient: string;
  status: 'accepted' | 'rejected';
  notificationId?: string;
  errors?: string[];
}

export interface BulkResponse {
  status: string;
  message: string;
  bulkRequestId: string;
  acceptedCount: number;
  rejectedCount: number;
  duplicate: boolean;
  results: BulkRecipientResult[];
}

interface NotificationCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: NotificationCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string): NotificationCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );

    if (
      typeof decoded.createdAt !== 'string' ||
      Number.isNaN(Date.parse(decoded.createdAt)) ||
      typeof decoded.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        decoded.id,
      )
    ) {
      throw new Error('Invalid cursor');
    }

    return decoded as NotificationCursor;
  } catch {
    throw new BadRequestException('Invalid pagination cursor.');
  }
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly database: DatabaseService) {}

  // Create a single notification.
  async create(
    input: CreateNotificationDto,
    idempotencyKey: string,
    tenantId: string,
  ) {
    if (input.channel !== 'email') {
      throw new BadRequestException(
        'Currently, only email notifications are supported',
      );
    }

    const key = idempotencyKey?.trim();

    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required.');
    }

    if (key.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key cannot exceed 255 characters.',
      );
    }

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
      // 1. Create the notification for the authenticated tenant.
      const notificationResult = await client.query(
        `INSERT INTO notifications
          (tenant_id, channel, recipient, message)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tenant_id, channel, recipient, message,
                   status, created_at`,
        [tenantId, input.channel, input.recipient, input.message],
      );

      const notification = notificationResult.rows[0];

      // 2. Register the idempotency key.
      const idempotencyResult = await client.query(
        `INSERT INTO idempotency_records
          (tenant_id, notification_id, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, idempotency_key)
         DO NOTHING
         RETURNING id`,
        [tenantId, notification.id, key, requestHash],
      );

      // 3. If the key already exists, remove the newly created
      //    notification and return the original result.
      if (idempotencyResult.rows.length === 0) {
        await client.query(
          `DELETE FROM notifications
           WHERE id = $1 AND tenant_id = $2`,
          [notification.id, tenantId],
        );

        const existingResult = await client.query(
          `SELECT
              n.id,
              n.tenant_id,
              n.channel,
              n.recipient,
              n.message,
              n.status,
              n.created_at,
              i.request_hash
           FROM idempotency_records i
           JOIN notifications n ON n.id = i.notification_id
           WHERE i.tenant_id = $1
             AND i.idempotency_key = $2`,
          [tenantId, key],
        );

        const existing = existingResult.rows[0];

        if (!existing) {
          throw new Error('Existing idempotency record not found.');
        }

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

      // 4. Create the outbox event in the same transaction.
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

  // Create multiple notifications in one bulk request.
  async createBulk(
    input: CreateBulkNotificationDto,
    idempotencyKey: string,
    tenantId: string,
  ): Promise<BulkResponse> {
    if (input.channel !== 'email') {
      throw new BadRequestException(
        'Currently, only email notifications are supported',
      );
    }

    const key = idempotencyKey?.trim();

    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required.');
    }

    if (key.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key cannot exceed 255 characters.',
      );
    }

    // Hash the complete bulk request.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          channel: input.channel,
          notificationType: input.notificationType,
          message: input.message,
          recipients: input.recipients,
        }),
      )
      .digest('hex');

    const response = await this.database.transaction(async (client) => {
      // 1. Register the complete bulk request.
      const bulkRequestResult = await client.query(
        `INSERT INTO bulk_requests
          (tenant_id, idempotency_key, request_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, idempotency_key)
         DO NOTHING
         RETURNING id`,
        [tenantId, key, requestHash],
      );

      // 2. Handle a previously submitted bulk request.
      if (bulkRequestResult.rows.length === 0) {
        const existingResult = await client.query(
          `SELECT id, request_hash, response
           FROM bulk_requests
           WHERE tenant_id = $1
             AND idempotency_key = $2
           FOR UPDATE`,
          [tenantId, key],
        );

        const existing = existingResult.rows[0];

        if (!existing) {
          throw new Error('Existing bulk request not found.');
        }

        if (existing.request_hash !== requestHash) {
          throw new ConflictException(
            'Idempotency key was already used with a different bulk request.',
          );
        }

        return {
          ...(existing.response as BulkResponse),
          duplicate: true,
        };
      }

      const bulkRequestId = bulkRequestResult.rows[0].id;

      const results: BulkRecipientResult[] = [];
      const seenRecipients = new Set<string>();

      let acceptedCount = 0;
      let rejectedCount = 0;

      // 3. Process each recipient independently.
      for (const [index, recipient] of input.recipients.entries()) {
        const emailValidation = z.string().email().safeParse(recipient);

        const normalizedRecipient = recipient.toLowerCase();

        const errors: string[] = [];

        if (!emailValidation.success) {
          errors.push('Invalid email address.');
        }

        if (seenRecipients.has(normalizedRecipient)) {
          errors.push('Duplicate recipient in this bulk request.');
        }

        seenRecipients.add(normalizedRecipient);

        // Invalid recipient: report rejection and continue.
        if (errors.length > 0) {
          rejectedCount++;

          results.push({
            index,
            recipient,
            status: 'rejected',
            errors,
          });

          continue;
        }

        // 4. Create an individual notification.
        const notificationResult = await client.query(
          `INSERT INTO notifications
            (
              tenant_id,
              channel,
              recipient,
              message,
              notification_type,
              bulk_request_id
            )
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, status, created_at`,
          [
            tenantId,
            input.channel,
            recipient,
            input.message,
            input.notificationType,
            bulkRequestId,
          ],
        );

        const notification = notificationResult.rows[0];

        // 5. Create its outbox event in the same transaction.
        await client.query(
          `INSERT INTO outbox_events
            (notification_id, routing_key, payload)
           VALUES ($1, $2, $3::jsonb)`,
          [
            notification.id,
            'notifications.email',
            JSON.stringify({
              id: notification.id,
              channel: input.channel,
              recipient,
              message: input.message,
            }),
          ],
        );

        acceptedCount++;

        results.push({
          index,
          recipient,
          status: 'accepted',
          notificationId: notification.id,
        });
      }

      // 6. Build the final bulk response.
      const finalResponse: BulkResponse = {
        status: acceptedCount > 0 ? 'accepted' : 'rejected',
        message:
          acceptedCount > 0
            ? 'Bulk request processed. Accepted notifications are queued for publishing.'
            : 'No valid recipients were accepted.',
        bulkRequestId,
        acceptedCount,
        rejectedCount,
        duplicate: false,
        results,
      };

      // 7. Save the response for future duplicate requests.
      await client.query(
        `UPDATE bulk_requests
         SET accepted_count = $2,
             rejected_count = $3,
             response = $4::jsonb
         WHERE id = $1
           AND tenant_id = $5`,
        [
          bulkRequestId,
          acceptedCount,
          rejectedCount,
          JSON.stringify(finalResponse),
          tenantId,
        ],
      );

      return finalResponse;
    });

    this.logger.log(
      `Bulk request ${response.bulkRequestId}: ` +
        `${response.acceptedCount} accepted, ` +
        `${response.rejectedCount} rejected.`,
    );

    return response;
  }

  async getNotifications(
    tenantId: string,
    query: {
      limit: number;
      cursor?: string;
      status?: string;
      channel?: string;
    },
  ) {
    const values: unknown[] = [tenantId];

    const conditions = ['tenant_id = $1'];

    // Optional status filter.
    if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }

    // Optional channel filter.
    if (query.channel) {
      values.push(query.channel);
      conditions.push(`channel = $${values.length}`);
    }

    // Cursor condition.
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);

      values.push(cursor.createdAt);
      const timestampIndex = values.length;

      values.push(cursor.id);
      const idIndex = values.length;

      conditions.push(
        `(created_at, id) < ($${timestampIndex}::timestamptz, $${idIndex}::uuid)`,
      );
    }

    // Fetch one extra record to determine whether another page exists.
    values.push(query.limit + 1);

    const result = await this.database.query(
      `
    SELECT
      id,
      channel,
      recipient,
      message,
      notification_type,
      status,
      created_at,
      updated_at
    FROM notifications
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT $${values.length}
    `,
      values,
    );

    const hasMore = result.rows.length > query.limit;

    const data = result.rows.slice(0, query.limit);

    const lastNotification = data[data.length - 1];

    const nextCursor =
      hasMore && lastNotification
        ? encodeCursor({
            createdAt: new Date(lastNotification.created_at).toISOString(),
            id: lastNotification.id,
          })
        : null;

    return {
      data,
      pagination: {
        limit: query.limit,
        hasMore,
        nextCursor,
      },
    };
  }
  async getNotificationById(notificationId: string, tenantId: string) {
    const result = await this.database.query(
      `
    SELECT
      id,
      channel,
      recipient,
      message,
      notification_type,
      status,
      attempts,
      last_error,
      provider_message_id,
      created_at,
      updated_at,
      processed_at
    FROM notifications
    WHERE id = $1
      AND tenant_id = $2
    LIMIT 1
    `,
      [notificationId, tenantId],
    );

    if (result.rows.length === 0) {
      throw new NotFoundException('Notification not found.');
    }

    return result.rows[0];
  }
}
