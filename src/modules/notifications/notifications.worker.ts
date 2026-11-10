import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';
import { DatabaseService } from '../../database/database.service.js';

import { EMAIL_PROVIDER } from './providers/email-provider.interface.js';
import type { EmailProvider } from './providers/email-provider.interface.js';

import { EmailProviderError } from './providers/brevo-email.provider.js';

@Injectable()
export class NotificationsWorkerService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsWorkerService.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly database: DatabaseService,

    @Inject(EMAIL_PROVIDER)
    private readonly emailProvider: EmailProvider,
  ) {}

  async onModuleInit() {
    await this.rabbitmq.consumeNotifications(async (notification, attempts) => {
      // 1. Atomically claim the notification.
      const lockToken = randomUUID();

      const claim = await this.database.query(
        `
          UPDATE notifications
          SET
            status = 'processing',
            attempts = attempts + 1,
            locked_until = NOW() + INTERVAL '30 seconds',
            locked_by = $2
          WHERE id = $1
            AND (
              status = 'pending'
              OR (
                status = 'processing'
                AND locked_until <= NOW()
              )
            )
          RETURNING id, channel, recipient, message, attempts, locked_by;
          `,
        [notification.id, lockToken],
      );

      // 2. Handle messages that cannot be claimed.
      if (claim.rows.length === 0) {
        const current = await this.database.query(
          `SELECT status FROM notifications WHERE id = $1`,
          [notification.id],
        );

        const existing = current.rows[0];

        if (!existing) {
          throw new Error(`Notification ${notification.id} not found`);
        }

        if (
          ['provider_accepted', 'delivered', 'failed', 'cancelled'].includes(
            existing.status,
          )
        ) {
          this.logger.log(
            `Notification ${notification.id} already completed. Skipping.`,
          );
          return;
        }

        throw new Error(
          `Notification ${notification.id} is currently not claimable`,
        );
      }

      const claimedNotification = claim.rows[0];

      this.logger.log(
        `Claimed notification ${claimedNotification.id}. Attempt: ${claimedNotification.attempts}`,
      );

      try {
        // 3. Send the actual email through Brevo.
        const emailResult = await this.emailProvider.send({
          to: claimedNotification.recipient,
          subject: 'Notification',
          textContent: claimedNotification.message,
        });

        this.logger.log(`Brevo accepted email for ${claimedNotification.id}`);

        // 4. Save provider acceptance and Brevo's message ID.
        const completed = await this.database.query(
          `
            UPDATE notifications
            SET
              status = 'provider_accepted',
              provider_message_id = $3,
              locked_until = NULL,
              locked_by = NULL,
              last_error = NULL
            WHERE id = $1
              AND status = 'processing'
              AND locked_by = $2
              AND locked_until > NOW()
            RETURNING id;
            `,
          [claimedNotification.id, lockToken, emailResult.providerMessageId],
        );

        if (completed.rows.length === 0) {
          throw new Error(
            `Lost processing lease for notification ${claimedNotification.id}`,
          );
        }

        this.logger.log(
          `Notification ${claimedNotification.id} successfully processed.`,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // 5. Permanent provider errors should not be retried.
        if (error instanceof EmailProviderError && !error.retryable) {
          const failed = await this.database.query(
            `
              UPDATE notifications
              SET
                status = 'failed',
                locked_until = NULL,
                locked_by = NULL,
                last_error = $3
              WHERE id = $1
                AND status = 'processing'
                AND locked_by = $2
              RETURNING id;
              `,
            [claimedNotification.id, lockToken, errorMessage],
          );

          if (failed.rows.length === 0) {
            throw new Error(
              `Could not mark notification ${claimedNotification.id} as failed`,
            );
          }

          this.logger.error(
            `Permanent email failure for ${claimedNotification.id}: ${errorMessage}`,
          );

          return; // Handler returns; RabbitMQ ACKs the message.
        }

        // 6. Temporary errors release the lease and trigger RabbitMQ retry.
        await this.database.query(
          `
            UPDATE notifications
            SET
              status = 'pending',
              locked_until = NULL,
              locked_by = NULL,
              last_error = $3
            WHERE id = $1
              AND status = 'processing'
              AND locked_by = $2;
            `,
          [claimedNotification.id, lockToken, errorMessage],
        );

        this.logger.warn(
          `Temporary processing failure for ${claimedNotification.id}: ${errorMessage}`,
        );

        throw error;
      }
    });
  }
}
