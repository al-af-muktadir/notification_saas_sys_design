import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
  Get,
  Param,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';

import { z } from 'zod';
import type { Request } from 'express';

import { NotificationsService } from './notifications.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';

import * as notificationDto from './dto/create-notification.dto.js';

const notificationHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),

  cursor: z.string().max(512).optional(),

  status: z
    .enum([
      'pending',
      'processing',
      'provider_accepted',
      'delivered',
      'retry_scheduled',
      'failed',
      'cancelled',
    ])
    .optional(),

  channel: z.enum(['email', 'sms', 'push', 'in_app']).optional(),
});

type NotificationHistoryQuery = z.infer<typeof notificationHistoryQuerySchema>;

interface AuthenticatedRequest extends Request {
  tenant: {
    id: string;
  };
}

@Controller('notifications')
@UseGuards(ApiKeyGuard)
export class NotificationsController {
  constructor(private readonly notificationService: NotificationsService) {}

  @Post()
  createNotification(
    @Body(new ZodValidationPipe(notificationDto.createNotificationSchema))
    body: notificationDto.CreateNotificationDto,

    @Headers('idempotency-key')
    idempotencyKey: string,

    @Req() request: AuthenticatedRequest,
  ) {
    const tenantId = request.tenant.id;

    return this.notificationService.create(body, idempotencyKey, tenantId);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.ACCEPTED)
  createBulkNotifications(
    @Body(new ZodValidationPipe(notificationDto.createBulkNotificationSchema))
    body: notificationDto.CreateBulkNotificationDto,

    @Headers('idempotency-key')
    idempotencyKey: string,

    @Req() request: AuthenticatedRequest,
  ) {
    const tenantId = request.tenant.id;

    return this.notificationService.createBulk(body, idempotencyKey, tenantId);
  }

  @Get()
  getNotifications(
    @Query(new ZodValidationPipe(notificationHistoryQuerySchema))
    query: NotificationHistoryQuery,

    @Req() request: AuthenticatedRequest,
  ) {
    return this.notificationService.getNotifications(request.tenant.id, query);
  }

  @Get(':id')
  getNotificationById(
    @Param('id', new ParseUUIDPipe())
    id: string,

    @Req() request: AuthenticatedRequest,
  ) {
    return this.notificationService.getNotificationById(id, request.tenant.id);
  }
}
