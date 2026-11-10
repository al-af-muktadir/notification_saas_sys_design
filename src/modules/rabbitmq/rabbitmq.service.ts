import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';

import amqp, {
  type ConfirmChannel,
  type ChannelModel,
  type Channel,
  ConsumeMessage,
} from 'amqplib';

const MAIN_EXCHANGE = 'notifications.main.exchange';
const RETRY_EXCHANGE = 'notifications.retry.exchange';

const MAIN_QUEUE = 'notifications.email';
const RETRY_QUEUE = 'notifications.email.retry';
const DLQ_QUEUE = 'notifications.email.dlq';

const MAIN_ROUTING_KEY = 'notifications.email';
const RETRY_ROUTING_KEY = 'notifications.email.retry';

const RETRY_DELAY = 35000;
const MAX_ATTEMPTS = 3;

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection!: ChannelModel;
  private channel!: ConfirmChannel;
  private consumerChannel!: Channel;
  async onModuleInit(): Promise<void> {
    // 1. Create RabbitMQ connection
    this.connection = await amqp.connect('amqp://localhost:5672');

    // 2. Create publisher ConfirmChannel
    this.channel = await this.connection.createConfirmChannel();

    // 3. Create consumer channel
    this.consumerChannel = await this.connection.createChannel();

    // 4. Configure exchanges and queues
    await this.setupNotificationQueues();

    console.log('RabbitMQ initialized');
  }
  async onModuleDestroy(): Promise<void> {
    console.log('Closing RabbitMQ connections...');

    if (this.consumerChannel) {
      await this.consumerChannel.close();
    }

    if (this.channel) {
      await this.channel.close();
    }

    if (this.connection) {
      await this.connection.close();
    }

    console.log('RabbitMQ connection closed');
  }

  getChannel(): ConfirmChannel {
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not initialized');
    }

    return this.channel;
  }

  // async publishNotification(notification: {
  //   id: string;
  //   channel: string;
  //   recipient: string;
  //   message: string;
  // }) {
  //   const message = Buffer.from(JSON.stringify(notification));
  //   const channel = this.getChannel();

  //   const published = channel.publish(
  //     MAIN_EXCHANGE,
  //     MAIN_ROUTING_KEY,
  //     message,
  //     {
  //       persistent: true,
  //       contentType: 'application/json',
  //       messageId: notification.id,
  //     },
  //   );

  //   if (!published) {
  //     this.logger.warn('RabbitMQ write buffer is full; waiting for drain');
  //   }

  //   await channel.waitForConfirms();

  //   this.logger.log(`Notification ${notification.id} published and confirmed`);
  // }

  async publishOutboxEvent(event: {
    id: string;
    routing_key: string;
    payload: unknown;
  }): Promise<void> {
    const channel = this.getChannel();

    const message = Buffer.from(JSON.stringify(event.payload));

    const accepted = channel.publish(
      MAIN_EXCHANGE,
      event.routing_key,
      message,
      {
        persistent: true,
        contentType: 'application/json',
        messageId: event.id,
      },
    );

    if (!accepted) {
      this.logger.warn('RabbitMQ write buffer is full; waiting for drain');

      await new Promise<void>((resolve) => {
        channel.once('drain', resolve);
      });
    }

    // Wait for RabbitMQ broker confirmation.
    await channel.waitForConfirms();

    this.logger.log(`Outbox event ${event.id} published and confirmed`);
  }

  async consumeNotifications(
    handler: (
      notification: {
        id: string;
        channel: string;
        recipient: string;
        message: string;
      },
      attempt: number,
    ) => Promise<void>,
  ): Promise<void> {
    await this.consumerChannel.prefetch(10);

    await this.consumerChannel.consume(
      MAIN_QUEUE,
      async (msg) => {
        if (!msg) return;
        let attempts = 0;
        console.log(msg, 'this is my msg');
        this.logger.log(
          `RECEIVED: ${msg.properties.messageId} at ${new Date().toISOString()}`,
        );

        try {
          const notification = JSON.parse(msg.content.toString());

          const previousFailures = this.getPreviousFailures(msg);

          attempts = previousFailures + 1;

          await handler(notification, attempts);
          this.logger.log(`ACK sent for notification ${notification.id}`);

          this.consumerChannel.ack(msg);
        } catch (error) {
          console.error(
            `Notification failed. Attempt ${attempts}/${MAX_ATTEMPTS}`,
            error,
          );

          if (attempts >= MAX_ATTEMPTS) {
            try {
              // Publish failed message to DLQ
              this.logger.error(
                `MOVING TO DLQ: Attempt ${attempts} at ${new Date().toISOString()}`,
              );
              this.channel.publish(MAIN_EXCHANGE, DLQ_QUEUE, msg.content, {
                persistent: true,
                contentType: 'application/json',
                headers: msg.properties.headers,
              });

              // Wait until RabbitMQ confirms DLQ publication
              await this.channel.waitForConfirms();

              // Original message can now be acknowledge
              this.consumerChannel.ack(msg);

              console.error('Notification moved to DLQ');
            } catch (dlqError) {
              console.error('Failed to publish to DLQ', dlqError);

              // Keep the original message
              this.consumerChannel.nack(msg, false, true);
            }
          } else {
            // Main queue DLx routes it to retry queue
            this.logger.warn(`Sending messagggggggg to retry queue`);
            this.consumerChannel.nack(msg, false, false);
          }
        }
      },
      { noAck: false },
    );
  }

  private async setupNotificationQueues(): Promise<void> {
    // 1. Create exchanges
    await this.channel.assertExchange(MAIN_EXCHANGE, 'direct', {
      durable: true,
    });

    await this.channel.assertExchange(RETRY_EXCHANGE, 'direct', {
      durable: true,
    });

    // 2. Main queue
    await this.channel.assertQueue(MAIN_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': RETRY_EXCHANGE,
        'x-dead-letter-routing-key': RETRY_ROUTING_KEY,
      },
    });

    // 3. Retry queue
    await this.channel.assertQueue(RETRY_QUEUE, {
      durable: true,
      arguments: {
        'x-message-ttl': RETRY_DELAY,
        'x-dead-letter-exchange': MAIN_EXCHANGE,
        'x-dead-letter-routing-key': MAIN_ROUTING_KEY,
      },
    });

    // 4. Dead Letter Queue
    await this.channel.assertQueue(DLQ_QUEUE, { durable: true });

    // 5. Bind main queue
    await this.channel.bindQueue(MAIN_QUEUE, MAIN_EXCHANGE, MAIN_ROUTING_KEY);

    // 6. Bind retry queue
    await this.channel.bindQueue(
      RETRY_QUEUE,
      RETRY_EXCHANGE,
      RETRY_ROUTING_KEY,
    );

    // 7. Bind DLQ
    await this.channel.bindQueue(DLQ_QUEUE, MAIN_EXCHANGE, DLQ_QUEUE);
  }

  private getPreviousFailures(msg: ConsumeMessage): number {
    const headers = msg.properties.headers ?? {};
    const xDeath = headers['x-death'];

    if (!Array.isArray(xDeath)) {
      return 0;
    }

    const mainQueueDeath = xDeath.find(
      (entry: { queue?: string }) => entry.queue === MAIN_QUEUE,
    );

    return Number(mainQueueDeath?.count ?? 0);
  }
}
