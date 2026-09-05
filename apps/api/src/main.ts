import 'dotenv/config';
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('RMS API')
    .setDescription('Restaurant Management System — Phase 1 (POS core). All money in integer paise, percentages in basis points.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, doc, { jsonDocumentUrl: 'api/docs-json' });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  new Logger('RMS').log(`API on http://localhost:${port}/api  •  Swagger on http://localhost:${port}/api/docs`);
}
bootstrap();
