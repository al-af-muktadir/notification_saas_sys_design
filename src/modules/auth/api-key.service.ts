import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseService } from '../../database/database.service.js';

export interface AuthenticatedTenant {
  id: string;
  name: string;
}

@Injectable()
export class ApiKeyService {
  constructor(private readonly database: DatabaseService) {}

  async createApiKey(
    tenantId: string,
    name: string,
  ): Promise<{ apiKey: string; prefix: string }> {
    // Generate a random prefix and secret.
    const prefix = randomBytes(6).toString('hex');
    const secret = randomBytes(32).toString('base64url');

    // This is the only time the plaintext key is available.
    const apiKey = `ntf_live_${prefix}_${secret}`;

    // Store its SHA-256 hash, never the plaintext key.
    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    await this.database.query(
      `INSERT INTO tenant_api_keys
        (tenant_id, name, key_prefix, key_hash)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, name, prefix, keyHash],
    );

    return { apiKey, prefix };
  }

  async validateApiKey(apiKey: string): Promise<AuthenticatedTenant | null> {
    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    const result = await this.database.query<AuthenticatedTenant>(
      `
    UPDATE tenant_api_keys AS k
    SET last_used_at = NOW()
    FROM tenants AS t
    WHERE k.tenant_id = t.id
      AND k.key_hash = $1
      AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > NOW())
    RETURNING k.tenant_id AS id, t.name
    `,
      [keyHash],
    );

    return result.rows[0] ?? null;
  }
}
