import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  validateRequiredEnv(configService);

  // Enable CORS
  app.enableCors();

  // Setup Swagger
  const config = new DocumentBuilder()
    .setTitle('Multi-Source RAG API')
    .setDescription(
      'API for uploading documents and asking questions on top of them',
    )
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const port = configService.get<number>('PORT') || 3000;
  await app.listen(port);
  const url = await app.getUrl();
  console.log(`Application is running on: ${url}`);
  console.log(`Swagger documentation: ${url}/api`);
}

function validateRequiredEnv(configService: ConfigService) {
  const requiredKeys = ['GEMINI_API_KEY', 'PINECONE_API_KEY', 'MONGODB_URI'];
  const missingKeys = requiredKeys.filter(
    (key) => !configService.get<string>(key),
  );

  if (missingKeys.length > 0) {
    console.error(
      `Missing required environment variable(s): ${missingKeys.join(', ')}`,
    );
    process.exit(1);
  }

  if (!configService.get<string>('COHERE_API_KEY')) {
    console.warn(
      'Warning: COHERE_API_KEY is not configured. Chunk reranking will be skipped.',
    );
  }
}

bootstrap();
