import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import {
  DocumentItem,
  DocumentSchema,
} from '../document/schemas/document.schema';
import { VectorModule } from '../vector/vector.module';
import { WebsiteItem, WebsiteSchema } from '../website/schemas/website.schema';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatSession, ChatSessionSchema } from './schemas/chat-session.schema';
import { Message, MessageSchema } from './schemas/message.schema';

import {
  SemanticCache,
  SemanticCacheSchema,
} from '../ai/schemas/semantic-cache.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Message.name, schema: MessageSchema },
      { name: ChatSession.name, schema: ChatSessionSchema },
      { name: DocumentItem.name, schema: DocumentSchema },
      { name: WebsiteItem.name, schema: WebsiteSchema },
      { name: SemanticCache.name, schema: SemanticCacheSchema },
    ]),
    AiModule,
    VectorModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
