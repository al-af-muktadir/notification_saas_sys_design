import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';
import { DatabaseService } from '../../database/database.service.js';

import { EMAIL_PROVIDER } from './providers/email-provider.interface.js';
import type { EmailProvider } from './providers/email-provider.interface.js';

import {
  EmailProviderError,
  EmailProviderDuplicateError,
} from './providers/brevo-email.provider.js';

@Injectable()
export class NotificationsWorkerService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsWorkerService.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly database: DatabaseService,

    @Inject(EMAIL_PROVIDER)
    private readonly emailProvider: EmailProvider,
  ) {}

  // Renews the processing lease while this worker is handling a notification.
  private startLeaseHeartbeat(notificationId: string, lockToken: string) {
    let leaseLost = false;
    let stopped = false;
    let renewalInFlight: Promise<void> | null = null;

    const renewLease = async () => {
      try {
        const result = await this.database.query(
          `
            UPDATE notifications
            SET locked_until = NOW() + INTERVAL '30 seconds'
            WHERE id = $1
              AND status = 'processing'
              AND locked_by = $2
              AND locked_until > NOW()
            RETURNING id;
          `,
          [notificationId, lockToken],
        );

        if (result.rows.length === 0) {
          leaseLost = true;
          this.logger.error(
            `Lost processing lease for notification ${notificationId}`,
          );
        }
      } catch (error) {
        leaseLost = true;
        this.logger.error(
          `Lease renewal failed for ${notificationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };

    const interval = setInterval(() => {
      if (stopped || leaseLost || renewalInFlight) return;

      renewalInFlight = renewLease().finally(() => {
        renewalInFlight = null;
      });
    }, 10_000);

    return {
      isLeaseLost: () => leaseLost,

      stop: async () => {
        stopped = true;
        clearInterval(interval);

        // Wait for an already-running renewal query to finish.
        if (renewalInFlight) {
          await renewalInFlight;
        }
      },
    };
  }

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

      // 3. Start renewing the lease.
      const heartbeat = this.startLeaseHeartbeat(
        claimedNotification.id,
        lockToken,
      );

      try {
        // 4. Send the email through Brevo.
        const emailResult = await this.emailProvider.send({
          to: claimedNotification.recipient,
          subject: 'Notification',
          textContent: claimedNotification.message,
          idempotencyKey: claimedNotification.id,
        });

        // Stop heartbeat before completing the database update.
        await heartbeat.stop();

        if (heartbeat.isLeaseLost()) {
          throw new Error(
            `Lost processing lease for notification ${claimedNotification.id}`,
          );
        }

        this.logger.log(`Brevo accepted email for ${claimedNotification.id}`);

        // 5. Save provider acceptance and Brevo's message ID.
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
        // Stop renewal before handling the error.
        await heartbeat.stop();

        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // 6. Brevo already processed this idempotency key.
        if (error instanceof EmailProviderDuplicateError) {
          const reconciled = await this.database.query(
            `
              UPDATE notifications
              SET
                status = 'provider_accepted',
                provider_message_id = NULL,
                locked_until = NULL,
                locked_by = NULL,
                last_error = NULL
              WHERE id = $1
                AND status = 'processing'
                AND locked_by = $2
                AND locked_until > NOW()
              RETURNING id;
            `,
            [claimedNotification.id, lockToken],
          );

          if (reconciled.rows.length === 0) {
            throw new Error(
              `Could not reconcile duplicate provider acceptance for ${claimedNotification.id}`,
            );
          }

          this.logger.warn(
            `Brevo confirmed previous processing for ${claimedNotification.id}. Skipping duplicate send.`,
          );

          return;
        }

        // 7. Permanent provider errors should not be retried.
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
                AND locked_until > NOW()
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

          return;
        }

        // 8. Temporary errors release the lease and trigger RabbitMQ retry.
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
              AND locked_by = $2
              AND locked_until > NOW();
          `,
          [claimedNotification.id, lockToken, errorMessage],
        );

        this.logger.warn(
          `Temporary processing failure for ${claimedNotification.id}: ${errorMessage}`,
        );

        throw error;
      } finally {
        // Always stop the heartbeat, including early returns and errors.
        await heartbeat.stop();
      }
    });
  }
}
