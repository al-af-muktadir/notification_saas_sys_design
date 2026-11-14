import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../../database/database.service.js';
import { BrevoWebhookProcessorService } from './brevo-webhook-processor.service.js';

interface PendingEvent {
  id: string;
}

@Injectable()
export class BrevoWebhookReconciliationService {
  private readonly logger = new Logger(BrevoWebhookReconciliationService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly processor: BrevoWebhookProcessorService,
  ) {}

  // Automatically runs every 30 seconds.
  @Cron('*/30 * * * * *')
  async reconcilePendingEvents(): Promise<void> {
    const result = await this.database.query<PendingEvent>(
      `
      SELECT id
      FROM provider_webhook_events
      WHERE processed_at IS NULL
      ORDER BY received_at ASC
      LIMIT 50
      `,
    );

    for (const event of result.rows) {
      try {
        const outcome = await this.database.transaction(async (client) => {
          return this.processor.process(client, event.id);
        });

        if (outcome === 'matched') {
          this.logger.log(`Reconciled webhook event ${event.id}`);
        }
      } catch (error) {
        this.logger.error(
          `Failed to reconcile webhook event ${event.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
