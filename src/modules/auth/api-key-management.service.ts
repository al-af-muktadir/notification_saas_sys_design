import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isIP } from 'node:net';
import { ApiKeyService } from './api-key.service.js';
import { DatabaseService } from '../../database/database.service.js';

function validateIps(ips: string[]): string[] {
  for (const ip of ips) {
    if (isIP(ip.trim()) === 0) {
      throw new BadRequestException(`Invalid IP address: ${ip}`);
    }
  }

  return ips.map((ip) => ip.trim());
}

@Injectable()
export class ApiKeyManagementService {
  constructor(
    private readonly database: DatabaseService,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  async create(
    tenantId: string,
    name: string,
    allowedIps: string[] = [],
    expiresAt: Date | null = null,
  ) {
    if (!name?.trim()) {
      throw new BadRequestException('Key name is required');
    }

    const ips = validateIps(allowedIps);

    return this.apiKeyService.createApiKey(
      tenantId,
      name.trim(),
      ips,
      expiresAt,
    );
  }

  async list(tenantId: string) {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, name, key_prefix, permissions, allowed_ips,
                created_at, last_used_at, expires_at, revoked_at
         FROM tenant_api_keys
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [tenantId],
      );

      return result.rows;
    });
  }

  async update(tenantId: string, keyId: string, allowedIps: string[]) {
    const ips = validateIps(allowedIps);

    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tenant_api_keys
         SET allowed_ips = $1
         WHERE id = $2
           AND tenant_id = $3
           AND revoked_at IS NULL
         RETURNING id, name, key_prefix, allowed_ips`,
        [ips, keyId, tenantId],
      );

      if (!result.rows[0]) {
        throw new NotFoundException('API key not found');
      }

      return result.rows[0];
    });
  }

  async revoke(tenantId: string, keyId: string) {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tenant_api_keys
         SET revoked_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND revoked_at IS NULL
         RETURNING id, name, revoked_at`,
        [keyId, tenantId],
      );

      if (!result.rows[0]) {
        throw new NotFoundException('API key not found');
      }

      return result.rows[0];
    });
  }
}
