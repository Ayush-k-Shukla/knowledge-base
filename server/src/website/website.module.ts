import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import {
  ChatSession,
  ChatSessionSchema,
} from '../chat/schemas/chat-session.schema';
import { VectorModule } from '../vector/vector.module';
import { WebsiteItem, WebsiteSchema } from './schemas/website.schema';
import { WebsiteController } from './website.controller';
import { WebsiteService } from './website.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WebsiteItem.name, schema: WebsiteSchema },
      { name: ChatSession.name, schema: ChatSessionSchema },
    ]),
    AiModule,
    VectorModule,
  ],
  providers: [WebsiteService],
  controllers: [WebsiteController],
})
export class WebsiteModule {}
