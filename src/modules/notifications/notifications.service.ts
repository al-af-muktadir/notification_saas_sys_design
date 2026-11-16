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

    const result = await this.database.tenantTransaction(
      tenantId,
      async (client) => {
        // 1. Create the notification.
        const notificationResult = await client.query(
          `INSERT INTO notifications
          (tenant_id, channel, recipient, message)
          VALUES ($1, $2, $3, $4)
          RETURNING id, tenant_id, channel, recipient, message,
                    status, created_at`,
          [tenantId, input.channel, input.recipient, input.message],
        );

        const notification = notificationResult.rows[0];

        // 2. Register the key in the shared idempotency table.
        const idempotencyResult = await client.query(
          `INSERT INTO idempotency_keys
          (tenant_id, idempotency_key, operation_type, request_hash, resource_id)
          VALUES ($1, $2, 'single', $3, $4)
          ON CONFLICT (tenant_id, idempotency_key)
          DO NOTHING
          RETURNING id`,
          [tenantId, key, requestHash, notification.id],
        );

        // 3. Handle an existing key.
        if (idempotencyResult.rows.length === 0) {
          await client.query(
            `DELETE FROM notifications
             WHERE id = $1 AND tenant_id = $2`,
            [notification.id, tenantId],
          );

          const existingResult = await client.query(
            `SELECT operation_type, request_hash, resource_id
             FROM idempotency_keys
             WHERE tenant_id = $1
               AND idempotency_key = $2`,
            [tenantId, key],
          );

          const existing = existingResult.rows[0];

          if (!existing) {
            throw new Error('Existing idempotency record not found.');
          }

          if (existing.operation_type !== 'single') {
            throw new ConflictException(
              'This idempotency key has already been used for a bulk request.',
            );
          }

          if (existing.request_hash !== requestHash) {
            throw new ConflictException(
              'Idempotency key was already used with a different request.',
            );
          }

          const existingNotificationResult = await client.query(
            `SELECT
              id, tenant_id, channel, recipient, message, status, created_at
             FROM notifications
             WHERE id = $1 AND tenant_id = $2`,
            [existing.resource_id, tenantId],
          );

          const existingNotification = existingNotificationResult.rows[0];

          if (!existingNotification) {
            throw new Error('Original notification was not found.');
          }

          return {
            duplicate: true,
            notification: existingNotification,
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
      },
    );

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

    const response = await this.database.tenantTransaction(
      tenantId,
      async (client) => {
        // 1. Create the bulk request.
        const bulkRequestResult = await client.query(
          `INSERT INTO bulk_requests
          (tenant_id, idempotency_key, request_hash)
          VALUES ($1, $2, $3)
          ON CONFLICT (tenant_id, idempotency_key)
          DO NOTHING
          RETURNING id`,
          [tenantId, key, requestHash],
        );

        // 2. If this bulk key already exists, retrieve its shared record.
        if (bulkRequestResult.rows.length === 0) {
          const existingResult = await client.query(
            `SELECT operation_type, request_hash, resource_id
             FROM idempotency_keys
             WHERE tenant_id = $1
               AND idempotency_key = $2`,
            [tenantId, key],
          );

          const existing = existingResult.rows[0];

          if (!existing) {
            throw new Error('Existing idempotency record not found.');
          }

          if (existing.operation_type !== 'bulk') {
            throw new ConflictException(
              'This idempotency key has already been used for a single notification.',
            );
          }

          if (existing.request_hash !== requestHash) {
            throw new ConflictException(
              'Idempotency key was already used with a different bulk request.',
            );
          }

          const existingBulkResult = await client.query(
            `SELECT response
             FROM bulk_requests
             WHERE id = $1 AND tenant_id = $2`,
            [existing.resource_id, tenantId],
          );

          const existingBulk = existingBulkResult.rows[0];

          if (!existingBulk?.response) {
            throw new Error('Original bulk response was not found.');
          }

          return {
            ...(existingBulk.response as BulkResponse),
            duplicate: true,
          };
        }

        const bulkRequestId = bulkRequestResult.rows[0].id;

        // 3. Register this key in the shared namespace.
        const idempotencyResult = await client.query(
          `INSERT INTO idempotency_keys
          (tenant_id, idempotency_key, operation_type, request_hash, resource_id)
          VALUES ($1, $2, 'bulk', $3, $4)
          ON CONFLICT (tenant_id, idempotency_key)
          DO NOTHING
          RETURNING id`,
          [tenantId, key, requestHash, bulkRequestId],
        );

        // 4. The key may already belong to the single endpoint.
        if (idempotencyResult.rows.length === 0) {
          await client.query(
            `DELETE FROM bulk_requests
             WHERE id = $1 AND tenant_id = $2`,
            [bulkRequestId, tenantId],
          );

          const existingResult = await client.query(
            `SELECT operation_type
             FROM idempotency_keys
             WHERE tenant_id = $1
               AND idempotency_key = $2`,
            [tenantId, key],
          );

          const existing = existingResult.rows[0];

          if (!existing) {
            throw new Error('Existing idempotency record not found.');
          }

          if (existing.operation_type !== 'bulk') {
            throw new ConflictException(
              'This idempotency key has already been used for a single notification.',
            );
          }

          throw new ConflictException(
            'This idempotency key is already registered for another bulk request.',
          );
        }

        const results: BulkRecipientResult[] = [];
        const seenRecipients = new Set<string>();

        let acceptedCount = 0;
        let rejectedCount = 0;

        // 5. Process each recipient independently.
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

          // 6. Create an individual notification.
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
            RETURNING id`,
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

          // 7. Create its outbox event.
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

        // 8. Build the final response.
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

        // 9. Save the response for future duplicate requests.
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
      },
    );

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
    return this.database.tenantTransaction(tenantId, async (client) => {
      const values: unknown[] = [tenantId];
      const conditions = ['tenant_id = $1'];

      if (query.status) {
        values.push(query.status);
        conditions.push(`status = $${values.length}`);
      }

      if (query.channel) {
        values.push(query.channel);
        conditions.push(`channel = $${values.length}`);
      }

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

      values.push(query.limit + 1);

      const result = await client.query(
        `
        SELECT
          id,
          channel,
          recipient,
          message,
          notification_type,
          status,
          created_at
         
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
    });
  }

  async getNotificationById(notificationId: string, tenantId: string) {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
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
        created_at
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
    });
  }
}
