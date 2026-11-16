import { z } from 'zod';

export const UpdateApiKeySchema = z
  .object({
    allowedIps: z.array(z.union([z.ipv4(), z.ipv6()])).max(50),
  })
  .strict();

export type UpdateApiKeyDto = z.infer<typeof UpdateApiKeySchema>;
