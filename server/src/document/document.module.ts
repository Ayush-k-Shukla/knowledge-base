import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import {
  ChatSession,
  ChatSessionSchema,
} from '../chat/schemas/chat-session.schema';
import { VectorModule } from '../vector/vector.module';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { DocumentItem, DocumentSchema } from './schemas/document.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentItem.name, schema: DocumentSchema },
      { name: ChatSession.name, schema: ChatSessionSchema },
    ]),
    AiModule,
    VectorModule,
  ],
  providers: [DocumentService],
  controllers: [DocumentController],
})
export class DocumentModule {}
