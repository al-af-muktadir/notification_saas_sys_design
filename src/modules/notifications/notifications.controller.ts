import { Body, Controller, Headers, Post } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import * as createNotificationDto from './dto/create-notification.dto.js';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationService: NotificationsService) {}

  @Post()
  createNotification(
    @Body(new ZodValidationPipe(createNotificationDto.createNotificationSchema))
    body: createNotificationDto.CreateNotificationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    console.log(idempotencyKey, 'i');
    return this.notificationService.create(body, idempotencyKey);
  }
}
