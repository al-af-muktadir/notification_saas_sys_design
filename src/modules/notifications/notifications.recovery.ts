// import { Injectable, Logger } from '@nestjs/common';
// import { Cron } from '@nestjs/schedule';
// import { DatabaseService } from '../../database/database.service.js';

// @Injectable()
// export class NotificationsRecoveryService {
//   private readonly logger = new Logger(NotificationsRecoveryService.name);
//   private running = false;

//   constructor(private readonly database: DatabaseService) {}

//   @Cron('*/5 * * * * *')
//   async recoverExpiredNotifications() {
//     // Prevent overlapping scans inside this instance.
//     if (this.running) return;

//     this.running = true;

//     try {
//       const result = await this.database.transaction(async (client) => {
//         return client.query(`
//           WITH expired AS (
//             SELECT id
//             FROM notifications
//             WHERE status = 'processing'
//               AND locked_until <= NOW()
//               AND channel = 'email'
//             ORDER BY locked_until
//             FOR UPDATE SKIP LOCKED
//             LIMIT 100
//           ),

//           exhausted AS (
//             UPDATE notifications n
//             SET status = 'failed',
//                 locked_by = NULL,
//                 locked_until = NULL,
//                 last_error = 'Maximum processing attempts exhausted'
//             FROM expired e
//             WHERE n.id = e.id
//               AND n.attempts >= 3
//             RETURNING n.id
//           ),

//           recovered AS (
//             UPDATE notifications n
//             SET status = 'pending',
//                 locked_by = NULL,
//                 locked_until = NULL,
//                 next_attempt_at = NOW(),
//                 last_error = 'Previous worker lease expired'
//             FROM expired e
//             WHERE n.id = e.id
//               AND n.attempts < 3
//             RETURNING n.id, n.channel, n.recipient, n.message
//           )

//           INSERT INTO outbox_events (
//             notification_id,
//             routing_key,
//             payload
//           )
//           SELECT
//             id,
//             'notifications.email',
//             jsonb_build_object(
//               'id', id,
//               'channel', channel,
//               'recipient', recipient,
//               'message', message
//             )
//           FROM recovered
//           RETURNING notification_id;
//         `);
//       });

//       if (result.rows.length > 0) {
//         this.logger.warn(
//           `Recovered ${result.rows.length} expired notifications`,
//         );
//       }
//     } catch (error) {
//       this.logger.error(
//         'Notification recovery scan failed',
//         error instanceof Error ? error.stack : String(error),
//       );
//     } finally {
//       this.running = false;
//     }
//   }
// }
