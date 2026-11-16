import { SetMetadata } from '@nestjs/common';

export const API_KEY_PERMISSION = 'api_key_permission';

export function RequireApiKeyPermission(permission: string) {
  return SetMetadata(API_KEY_PERMISSION, permission);
}
