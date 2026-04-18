import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { AiModule } from '../ai/ai.module';
import { VectorModule } from '../vector/vector.module';
import { DocumentItem, DocumentSchema } from './schemas/document.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: DocumentItem.name, schema: DocumentSchema }]),
    AiModule,
    VectorModule,
  ],
  providers: [DocumentService],
  controllers: [DocumentController],
})
export class DocumentModule {}

