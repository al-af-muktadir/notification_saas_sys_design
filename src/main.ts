import { NestFactory } from '@nestjs/core';
import 'dotenv/config';
import { AppModule, ObserveInstrument } from './app.module.js';
import { loadEnvFile } from 'node:process';

async function bootstrap() {
  loadEnvFile();
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  await app.listen(process.env.PORT ?? 3000, () => {
    //g('Notification SAAS is SAASISNG');
  });
}
await bootstrap();
