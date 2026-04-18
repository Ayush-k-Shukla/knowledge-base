import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WebsiteService } from './website.service';
import { WebsiteController } from './website.controller';
import { AiModule } from '../ai/ai.module';
import { VectorModule } from '../vector/vector.module';
import { WebsiteItem, WebsiteSchema } from './schemas/website.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: WebsiteItem.name, schema: WebsiteSchema }]),
    AiModule,
    VectorModule,
  ],
  providers: [WebsiteService],
  controllers: [WebsiteController],
})
export class WebsiteModule {}
