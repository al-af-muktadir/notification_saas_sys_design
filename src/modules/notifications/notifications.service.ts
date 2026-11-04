import { Injectable } from '@nestjs/common';
import type { CreateNotificationDto } from './dto/create-notification.dto.js';
import { DatabaseService } from '../../database/database.service.js';

@Injectable()
export class NotificationsService {
  constructor(private readonly database: DatabaseService) {}
  async create(input: CreateNotificationDto, idempotencyKey?: string) {
    const key = idempotencyKey ? idempotencyKey : null;
    const result = await this.database.query(
      `INSERT INTO notifications
    (channel, recipient, message, idempotency_key)
VALUES ($1, $2, $3, $4)
ON CONFLICT (idempotency_key)
    WHERE idempotency_key IS NOT NULL
DO NOTHING
RETURNING id, channel, recipient, message, status, created_at, idempotency_key;`,
      [input.channel, input.recipient, input.message, key],
    );

    //g('[Service] INSERT result:', result.rows);
    //g('[Service] Rows returned:', result.rowCount);

    return {
      status: 'accepted',
      message: 'Notification request received',
      notification: input,
    };
  }
}
