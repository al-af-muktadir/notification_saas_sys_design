import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedRequest } from './api-key.guard.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeyPermissionGuard } from './api-key-permission.guard.js';
import { RequireApiKeyPermission } from './api-key-permission.decorator.js';
import { ApiKeyManagementService } from './api-key-management.service.js';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import {
  CreateApiKeySchema,
  type CreateApiKeyDto,
} from './dto/create-api-key.dto.js';

import {
  UpdateApiKeySchema,
  type UpdateApiKeyDto,
} from './dto/update-api-key.dto.js';

@Controller('api-keys')
@UseGuards(ApiKeyGuard, ApiKeyPermissionGuard)
@RequireApiKeyPermission('keys:manage')
export class ApiKeyManagementController {
  constructor(private readonly service: ApiKeyManagementService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateApiKeySchema))
    body: CreateApiKeyDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const expiry = body.expiresAt ? new Date(body.expiresAt) : null;

    return this.service.create(
      request.tenant.id,
      body.name,
      body.allowedIps,
      expiry,
    );
  }

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.service.list(request.tenant.id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateApiKeySchema))
    body: UpdateApiKeyDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.update(request.tenant.id, id, body.allowedIps);
  }

  @Delete(':id')
  revoke(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.service.revoke(request.tenant.id, id);
  }
}
