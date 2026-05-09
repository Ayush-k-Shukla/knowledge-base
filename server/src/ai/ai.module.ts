import { Module } from '@nestjs/common';
import { AiService } from './ai.service';

import { MongooseModule } from '@nestjs/mongoose';
import { VectorModule } from '../vector/vector.module';
import {
  SemanticCache,
  SemanticCacheSchema,
} from './schemas/semantic-cache.schema';

import { SemanticCacheService } from './semantic-cache.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SemanticCache.name, schema: SemanticCacheSchema },
    ]),
    VectorModule,
  ],
  providers: [AiService, SemanticCacheService],
  exports: [AiService, SemanticCacheService],
})
export class AiModule {}
