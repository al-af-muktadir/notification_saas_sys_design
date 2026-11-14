import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseService } from '../../../database/database.service.js';

@Injectable()
export class TenantRegistrationService {
  constructor(private readonly database: DatabaseService) {}

  async registerTenant(name: string) {
    return this.database.transaction(async (client) => {
      // 1. Create tenant
      const tenantResult = await client.query(
        `
        INSERT INTO tenants (name)
        VALUES ($1)
        RETURNING id, name
        `,
        [name],
      );

      const tenant = tenantResult.rows[0];

      // 2. Generate API key
      const prefix = randomBytes(6).toString('hex');
      const secret = randomBytes(32).toString('base64url');

      const apiKey = `ntf_live_${prefix}_${secret}`;

      // 3. Hash API key
      const keyHash = createHash('sha256').update(apiKey).digest('hex');

      // 4. Store API key hash
      await client.query(
        `
        INSERT INTO tenant_api_keys
          (tenant_id, name, key_prefix, key_hash)
        VALUES ($1, $2, $3, $4)
        `,
        [tenant.id, 'Production', prefix, keyHash],
      );

      // 5. Return plaintext key only once
      return {
        tenant: {
          id: tenant.id,
          name: tenant.name,
        },
        apiKey,
      };
    });
  }
}
