import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { TenantRegistrationService } from './tenant-registration.service.js';

@Controller('auth')
export class TenantRegistrationController {
  constructor(
    private readonly registrationService: TenantRegistrationService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() body: { name: string }) {
    return this.registrationService.registerTenant(body.name);
  }
}
