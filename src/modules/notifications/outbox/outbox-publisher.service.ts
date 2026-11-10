import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';

import { RabbitMQService } from '../../rabbitmq/rabbitmq.service.js';
import { DatabaseService } from '../../../database/database.service.js';

interface OutboxEvent {
  id: string;
  notification_id: string;
  routing_key: string;
  payload: unknown;
  attempts: number;
}

@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);

  private running = false;

  private readonly batchSize = 10;
  private readonly maxAttempts = 10;
  private crashTestTriggered = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly rabbitmq: RabbitMQService,
  ) {}

  @Cron('* * * * * *')
  async publishPendingEvents(): Promise<void> {
    if (this.running) return;

    this.running = true;

    try {
      const lockToken = randomUUID();

      const events = await this.database.transaction(async (client) => {
        const result = await client.query<OutboxEvent>(
          `
          WITH candidates AS (
            SELECT id
            FROM outbox_events
            WHERE
              (
                status = 'pending'
                AND available_at <= NOW()
              )
              OR
              (
                status = 'processing'
                AND locked_until <= NOW()
              )
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $2
          )
          UPDATE outbox_events AS o
          SET
            status = 'processing',
            attempts = o.attempts + 1,
            locked_by = $1,
            locked_until = NOW() + INTERVAL '30 seconds'
          FROM candidates
          WHERE o.id = candidates.id
          RETURNING
            o.id,
            o.notification_id,
            o.routing_key,
            o.payload,
            o.attempts;
          `,
          [lockToken, this.batchSize],
        );

        return result.rows;
      });

      if (events.length === 0) return;

      this.logger.log(`Claimed ${events.length} outbox events`);

      for (const event of events) {
        await this.publishSingleEvent(event, lockToken);
      }
    } catch (error) {
      this.logger.error('Outbox publishing cycle failed', error);
    } finally {
      this.running = false;
    }
  }

  private async publishSingleEvent(
    event: OutboxEvent,
    lockToken: string,
  ): Promise<void> {
    try {
      // 1. Publish and wait for RabbitMQ confirmation.
      await this.rabbitmq.publishOutboxEvent({
        id: event.id,
        routing_key: event.routing_key,
        payload: event.payload,
      });
      // TEST: Crash after RabbitMQ confirmation, before PostgreSQL update.
      //   if (
      //     process.env.OUTBOX_CRASH_AFTER_CONFIRM === 'true' &&
      //     !this.crashTestTriggered
      //   ) {
      //     this.crashTestTriggered = true;

      //     this.logger.error(
      //       `TEST: Crashing after RabbitMQ confirmed event ${event.id}`,
      //     );

      //     process.exit(1);
      //   }
      // 2. Mark the event published only after confirmation.
      const result = await this.database.query(
        `
        UPDATE outbox_events
        SET
          status = 'published',
          published_at = NOW(),
          locked_by = NULL,
          locked_until = NULL,
          last_error = NULL
        WHERE id = $1
          AND status = 'processing'
          AND locked_by = $2
        RETURNING id;
        `,
        [event.id, lockToken],
      );

      if (result.rows.length === 0) {
        this.logger.warn(
          `Could not mark outbox event ${event.id} as published: lease ownership lost`,
        );
        return;
      }

      this.logger.log(`Outbox event ${event.id} marked as published`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // 3. Retry with exponential backoff, or stop after max attempts.
      await this.database.query(
        `
        UPDATE outbox_events
        SET
          status = CASE
            WHEN attempts >= $3 THEN 'failed'
            ELSE 'pending'
          END,
          available_at = NOW() +
            (
              LEAST(POWER(2, LEAST(attempts, 8)) * 1000, 300000)
              * INTERVAL '1 millisecond'
            ),
          locked_by = NULL,
          locked_until = NULL,
          last_error = $4
        WHERE id = $1
          AND status = 'processing'
          AND locked_by = $2;
        `,
        [event.id, lockToken, this.maxAttempts, errorMessage],
      );

      this.logger.error(
        `Failed to publish boxout event ${event.id}. Attempt ${event.attempts}/${this.maxAttempts}`,
        errorMessage,
      );
    }
  }
}
