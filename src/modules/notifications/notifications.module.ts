import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { DatabaseModule } from '../../database/database.module.js';
import { RabbitMQModule } from '../rabbitmq/rabbitmq.module.js';
import { NotificationsWorkerService } from './notifications.worker.js';
import { OutboxPublisherService } from './outbox/outbox-publisher.service.js';
import { BrevoEmailProvider } from './providers/brevo-email.provider.js';
import { EMAIL_PROVIDER } from './providers/email-provider.interface.js';
import { BrevoWebhookController } from './brevo-webhook.controller.js';
@Module({
  imports: [DatabaseModule, RabbitMQModule],
  controllers: [NotificationsController, BrevoWebhookController],
  providers: [
    NotificationsService,
    NotificationsWorkerService,
    OutboxPublisherService,
    BrevoEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      useExisting: BrevoEmailProvider,
    },
  ],
})
export class NotificationsModule {}
