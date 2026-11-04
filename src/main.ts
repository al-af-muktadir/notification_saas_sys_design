import { NestFactory } from '@nestjs/core';
import 'dotenv/config';
import { AppModule, ObserveInstrument } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  await app.listen(process.env.PORT ?? 3000, () => {
    //g('Notification SAAS is SAASISNG');
  });
}
await bootstrap();
