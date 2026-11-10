import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { createObserveModule } from '@nestjs/observe';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthModule } from './modules/health/health.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { DatabaseModule } from './database/database.module.js';
import { RabbitMQModule } from './modules/rabbitmq/rabbitmq.module.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRE',
      serviceId: 'notification-saas',
    }),

    ScheduleModule.forRoot(),

    HealthModule,
    NotificationsModule,
    DatabaseModule,
    RabbitMQModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
