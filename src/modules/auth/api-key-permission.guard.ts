import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from './api-key.guard.js';
import { API_KEY_PERMISSION } from './api-key-permission.decorator.js';

@Injectable()
export class ApiKeyPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermission = this.reflector.getAllAndOverride<string>(
      API_KEY_PERMISSION,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermission) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.tenant.permissions.includes(requiredPermission)) {
      throw new ForbiddenException('Insufficient API key permissions');
    }

    return true;
  }
}
