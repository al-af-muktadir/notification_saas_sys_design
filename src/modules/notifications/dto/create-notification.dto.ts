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

export const createBulkNotificationSchema = z.object({
  channel: z.enum(['email', 'sms', 'push', 'in-app']),

  notificationType: z
    .enum(['transactional', 'marketing'])
    .default('transactional'),

  message: z
    .string()
    .trim()
    .min(1, 'Message is required')
    .max(5000, 'Message is too long'),

  recipients: z
    .array(z.string().trim().min(1, 'Recipient cannot be empty'))
    .min(1, 'At least one recipient is required')
    .max(500, 'A maximum of 500 recipients is allowed'),
});

export type CreateBulkNotificationDto = z.infer<
  typeof createBulkNotificationSchema
>;
