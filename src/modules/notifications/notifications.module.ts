import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { DatabaseModule } from '../../database/database.module.js';
import { RabbitMQModule } from '../rabbitmq/rabbitmq.module.js';
import { AuthModule } from '../auth/auth.module.js';

import { NotificationsWorkerService } from './notifications.worker.js';
import { OutboxPublisherService } from './outbox/outbox-publisher.service.js';
import { BrevoEmailProvider } from './providers/brevo-email.provider.js';
import { EMAIL_PROVIDER } from './providers/email-provider.interface.js';
import { BrevoWebhookController } from './brevo-webhook.controller.js';
import { BrevoWebhookReconciliationService } from './brevo-webhook-reconciliation.service.js';
import { BrevoWebhookProcessorService } from './brevo-webhook-processor.service.js';

@Module({
  imports: [DatabaseModule, RabbitMQModule, AuthModule],
  controllers: [NotificationsController, BrevoWebhookController],
  providers: [
    NotificationsService,
    BrevoWebhookReconciliationService,
    NotificationsWorkerService,
    BrevoWebhookProcessorService,
    OutboxPublisherService,
    BrevoEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      useExisting: BrevoEmailProvider,
    },
  ],
})
export class NotificationsModule {}
