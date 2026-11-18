import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module.js';
import { RabbitMQModule } from './modules/rabbitmq/rabbitmq.module.js';

import { NotificationsWorkerService } from './modules/notifications/notifications.worker.js';

import { BrevoEmailProvider } from './modules/notifications/providers/brevo-email.provider.js';
import { EMAIL_PROVIDER } from './modules/notifications/providers/email-provider.interface.js';

@Module({
  imports: [DatabaseModule, RabbitMQModule],
  providers: [
    NotificationsWorkerService,
    BrevoEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      useExisting: BrevoEmailProvider,
    },
  ],
})
export class WorkerModule {}
