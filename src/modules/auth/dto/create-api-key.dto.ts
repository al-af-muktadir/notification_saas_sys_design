import { z } from 'zod';

export const CreateApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),

    allowedIps: z
      .array(z.union([z.ipv4(), z.ipv6()]))
      .max(50)
      .optional()
      .default([]),

    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type CreateApiKeyDto = z.infer<typeof CreateApiKeySchema>;
