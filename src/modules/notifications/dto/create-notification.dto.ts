import { z } from 'zod';

export const createNotificationSchema = z.object({
  channel: z.enum(['email', 'sms', 'push', 'in-app']),

  recipient: z.string().trim().min(1, 'Recipient is required'),

  message: z
    .string()
    .trim()
    .min(1, 'Message is required')
    .max(5000, 'Message is too long'),
});

export type CreateNotificationDto = z.infer<typeof createNotificationSchema>;
