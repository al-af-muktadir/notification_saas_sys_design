import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyService, AuthenticatedTenant } from './api-key.service.js';

export type AuthenticatedRequest = Request & {
  tenant: AuthenticatedTenant;
};

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const authorization = request.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('API key is required');
    }

    const apiKey = authorization.slice(7).trim();

    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    const tenant = await this.apiKeyService.validateApiKey(apiKey);

    if (!tenant) {
      throw new UnauthorizedException('Invalid or expired API key');
    }

    // Attach the server-verified tenant identity.
    request.tenant = tenant;

    return true;
  }
}
