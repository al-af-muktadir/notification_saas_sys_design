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
  type ConsumeMessage,
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

type NotificationPayload = {
  id: string;
  channel: string;
  recipient: string;
  message: string;
};

type NotificationHandler = (
  notification: NotificationPayload,
  attempt: number,
) => Promise<void>;

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);

  private connection!: ChannelModel;
  private channel!: ConfirmChannel;
  private consumerChannel!: Channel;

  private consumerTag?: string;

  // Tracks all notification handlers currently executing.
  private readonly inFlightHandlers = new Set<Promise<void>>();

  private isShuttingDown = false;

  async onModuleInit(): Promise<void> {
    this.connection = await amqp.connect('amqp://localhost:5672');

    this.channel = await this.connection.createConfirmChannel();
    this.consumerChannel = await this.connection.createChannel();

    await this.setupNotificationQueues();

    this.logger.log('RabbitMQ initialized');
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Starting RabbitMQ graceful shutdown...');

    this.isShuttingDown = true;

    // 1. Stop RabbitMQ from delivering new messages to this consumer.
    if (this.consumerTag && this.consumerChannel) {
      try {
        await this.consumerChannel.cancel(this.consumerTag);
        this.logger.log('RabbitMQ consumer cancelled');
      } catch (error) {
        this.logger.error('Failed to cancel RabbitMQ consumer', error);
      }
    }

    // 2. Wait for already-running notification handlers.
    while (this.inFlightHandlers.size > 0) {
      this.logger.log(
        `Waiting for ${this.inFlightHandlers.size} active notification handler(s)...`,
      );

      await Promise.allSettled([...this.inFlightHandlers]);
    }

    this.logger.log('All active notification handlers finished');

    // 3. Close the consumer channel after handlers finish.
    if (this.consumerChannel) {
      await this.consumerChannel.close();
    }

    // 4. Close the publisher channel.
    if (this.channel) {
      await this.channel.close();
    }

    // 5. Close the connection.
    if (this.connection) {
      await this.connection.close();
    }

    this.logger.log('RabbitMQ connection closed');
  }

  getChannel(): ConfirmChannel {
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not initialized');
    }

    return this.channel;
  }

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

    await channel.waitForConfirms();

    this.logger.log(`Outbox event ${event.id} published and confirmed`);
  }

  async consumeNotifications(handler: NotificationHandler): Promise<void> {
    await this.consumerChannel.prefetch(10);

    const result = await this.consumerChannel.consume(
      MAIN_QUEUE,
      (msg) => {
        if (!msg) return;

        // If shutdown has started, leave this delivery unacknowledged.
        // Closing the channel will make RabbitMQ redeliver it.
        if (this.isShuttingDown) {
          return;
        }

        const task = this.handleMessage(msg, handler);

        this.inFlightHandlers.add(task);

        // Remove the task from the tracking set when it finishes.
        void task.then(
          () => this.inFlightHandlers.delete(task),
          () => this.inFlightHandlers.delete(task),
        );
      },
      { noAck: false },
    );

    this.consumerTag = result.consumerTag;

    this.logger.log(`Notification consumer started: ${this.consumerTag}`);
  }

  private async handleMessage(
    msg: ConsumeMessage,
    handler: NotificationHandler,
  ): Promise<void> {
    let attempts = 0;

    this.logger.log(
      `RECEIVED: ${msg.properties.messageId} at ${new Date().toISOString()}`,
    );

    try {
      const notification = JSON.parse(
        msg.content.toString(),
      ) as NotificationPayload;

      const previousFailures = this.getPreviousFailures(msg);

      attempts = previousFailures + 1;

      await handler(notification, attempts);

      this.consumerChannel.ack(msg);

      this.logger.log(`ACK sent for notification ${notification.id}`);
    } catch (error) {
      this.logger.error(
        `Notification failed. Attempt ${attempts}/${MAX_ATTEMPTS}`,
        error instanceof Error ? error.stack : String(error),
      );

      if (attempts >= MAX_ATTEMPTS) {
        try {
          this.logger.error(
            `MOVING TO DLQ: Attempt ${attempts} at ${new Date().toISOString()}`,
          );

          const accepted = this.channel.publish(
            MAIN_EXCHANGE,
            DLQ_QUEUE,
            msg.content,
            {
              persistent: true,
              contentType: 'application/json',
              messageId: msg.properties.messageId,
              headers: msg.properties.headers,
            },
          );

          if (!accepted) {
            await new Promise<void>((resolve) => {
              this.channel.once('drain', resolve);
            });
          }

          // Confirm DLQ publication before acknowledging original.
          await this.channel.waitForConfirms();

          this.consumerChannel.ack(msg);

          this.logger.error('Notification moved to DLQ');
        } catch (dlqError) {
          this.logger.error(
            'Failed to publish to DLQ',
            dlqError instanceof Error ? dlqError.stack : String(dlqError),
          );

          this.consumerChannel.nack(msg, false, true);
        }
      } else {
        this.logger.warn('Sending message to retry queue');

        // Main queue DLX routes the message to the retry queue.
        this.consumerChannel.nack(msg, false, false);
      }
    }
  }

  private async setupNotificationQueues(): Promise<void> {
    await this.channel.assertExchange(MAIN_EXCHANGE, 'direct', {
      durable: true,
    });

    await this.channel.assertExchange(RETRY_EXCHANGE, 'direct', {
      durable: true,
    });

    await this.channel.assertQueue(MAIN_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': RETRY_EXCHANGE,
        'x-dead-letter-routing-key': RETRY_ROUTING_KEY,
      },
    });

    await this.channel.assertQueue(RETRY_QUEUE, {
      durable: true,
      arguments: {
        'x-message-ttl': RETRY_DELAY,
        'x-dead-letter-exchange': MAIN_EXCHANGE,
        'x-dead-letter-routing-key': MAIN_ROUTING_KEY,
      },
    });

    await this.channel.assertQueue(DLQ_QUEUE, {
      durable: true,
    });

    await this.channel.bindQueue(MAIN_QUEUE, MAIN_EXCHANGE, MAIN_ROUTING_KEY);

    await this.channel.bindQueue(
      RETRY_QUEUE,
      RETRY_EXCHANGE,
      RETRY_ROUTING_KEY,
    );

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
