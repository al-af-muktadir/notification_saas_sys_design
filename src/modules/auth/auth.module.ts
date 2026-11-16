import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';

import { ApiKeyService } from './api-key.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeyPermissionGuard } from './api-key-permission.guard.js';

import { TenantRegistrationService } from './tanent-registration/tenant-registration.service.js';
import { TenantRegistrationController } from './tanent-registration/tanent-registration.controller.js';
import { ApiKeyManagementService } from './api-key-management.service.js';
import { ApiKeyManagementController } from './api-key-management.controller.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    ApiKeyService,
    ApiKeyGuard,
    ApiKeyPermissionGuard,
    ApiKeyManagementService,
    TenantRegistrationService,
  ],
  exports: [
    ApiKeyService,
    ApiKeyGuard,
    ApiKeyPermissionGuard,
    TenantRegistrationService,
  ],
  controllers: [TenantRegistrationController, ApiKeyManagementController],
})
export class AuthModule {}
