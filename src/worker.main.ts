import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  app.enableShutdownHooks();

  console.log('Notification worker started');
}

void bootstrap();
