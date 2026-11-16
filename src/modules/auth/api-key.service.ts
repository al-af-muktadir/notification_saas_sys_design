import { ForbiddenException, Injectable } from '@nestjs/common';

import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

import { DatabaseService } from '../../database/database.service.js';

export interface AuthenticatedTenant {
  id: string;
  name: string;
  permissions: string[];
}

function normalizeIp(ip: string): string {
  const normalized = ip.trim().toLowerCase();

  // Convert IPv4-mapped IPv6 addresses to ordinary IPv4.
  if (normalized.startsWith('::ffff:')) {
    const ipv4 = normalized.slice(7);

    if (isIP(ipv4) === 4) {
      return ipv4;
    }
  }

  if (!isIP(normalized)) {
    throw new Error('Invalid IP address');
  }

  // IPv6 addresses must be stored in canonical form
  // in allowed_ips for reliable matching.
  return normalized;
}

@Injectable()
export class ApiKeyService {
  constructor(private readonly database: DatabaseService) {}

  async createApiKey(
    tenantId: string,
    name: string,
    allowedIps: string[] = [],
    expiresAt: Date | null = null,
  ): Promise<{ apiKey: string; prefix: string }> {
    const prefix = randomBytes(6).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const apiKey = `ntf_live_${prefix}_${secret}`;
    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_api_keys
       (tenant_id, name, key_prefix, key_hash, allowed_ips, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, name, prefix, keyHash, allowedIps, expiresAt],
      );
    });

    return { apiKey, prefix };
  }

  async validateApiKey(
    apiKey: string,
    clientIp: string | undefined,
  ): Promise<AuthenticatedTenant | null> {
    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    const result = await this.database.query<{
      id: string;
      name: string;
      allowed_ips: string[];
      permissions: string[];
    }>(
      `
      SELECT
  k.tenant_id AS id,
  t.name,
  k.allowed_ips,
  k.permissions
FROM tenant_api_keys AS k
JOIN tenants AS t ON t.id = k.tenant_id
WHERE k.key_hash = $1
  AND k.revoked_at IS NULL
  AND (k.expires_at IS NULL OR k.expires_at > NOW())
LIMIT 1
      `,
      [keyHash],
    );

    const key = result.rows[0];

    if (!key) {
      return null;
    }

    const allowedIps = key.allowed_ips ?? [];

    // An empty allowlist means no IP restriction.
    if (allowedIps.length > 0) {
      if (!clientIp) {
        throw new ForbiddenException('Unable to verify the client IP address.');
      }

      let normalizedClientIp: string;

      try {
        normalizedClientIp = normalizeIp(clientIp);
      } catch {
        throw new ForbiddenException('Invalid client IP address.');
      }

      const normalizedAllowedIps = allowedIps.map(normalizeIp);

      if (!normalizedAllowedIps.includes(normalizedClientIp)) {
        throw new ForbiddenException(
          'API key is not allowed from this IP address.',
        );
      }
    }

    // Update usage only after the IP check succeeds.
    const updateResult = await this.database.query(
      `
      UPDATE tenant_api_keys
      SET last_used_at = NOW()
      WHERE key_hash = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      RETURNING id
      `,
      [keyHash],
    );

    // Recheck validity in case the key was revoked or expired
    // between the initial lookup and this update.
    if (updateResult.rows.length === 0) {
      return null;
    }

    return {
      id: key.id,
      name: key.name,
      permissions: key.permissions ?? [],
    };
  }
}
