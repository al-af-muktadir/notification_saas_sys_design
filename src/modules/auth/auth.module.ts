import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { ApiKeyService } from './api-key.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { TenantRegistrationService } from './tanent-registration/tenant-registration.service.js';
import { TenantRegistrationController } from './tanent-registration/tanent-registration.controller.js';

@Module({
  imports: [DatabaseModule],
  providers: [ApiKeyService, ApiKeyGuard, TenantRegistrationService],
  exports: [ApiKeyService, ApiKeyGuard, TenantRegistrationService],
  controllers: [TenantRegistrationController],
})
export class AuthModule {}
