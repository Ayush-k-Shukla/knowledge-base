import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pinecone } from '@pinecone-database/pinecone';

@Injectable()
export class VectorService implements OnModuleInit {
  private readonly logger = new Logger(VectorService.name);
  private pinecone: Pinecone;
  private indexName: string;

  constructor(private configService: ConfigService) {
    this.pinecone = new Pinecone({
      apiKey: this.configService.get<string>('PINECONE_API_KEY')!,
    });
    this.indexName = this.configService.get<string>('PINECONE_INDEX_NAME')!;
  }

  async onModuleInit() {
    // Basic connectivity check can go here if needed
  }

  async upsert(vectors: any[]) {
    this.logger.debug(
      `[Vector] Upserting ${vectors.length} vectors into index ${this.indexName}`,
    );
    const index = this.pinecone.Index(this.indexName);
    // SDK 7.x requires an object with 'records'
    await index.upsert({ records: vectors });
  }

  async query(
    vector: number[],
    topK: number = 5,
    filter?: Record<string, any>,
  ) {
    this.logger.debug(
      `[Vector] Querying index ${this.indexName} with topK=${topK} filter=${JSON.stringify(filter)}`,
    );
    const index = this.pinecone.Index(this.indexName);
    const result = await index.query({
      vector,
      topK,
      filter,
      includeMetadata: true,
    });
    this.logger.debug(
      `[Vector] Query returned ${result.matches?.length ?? 0} matches`,
    );
    return result.matches;
  }

  async deleteByChatId(chatId: string) {
    this.logger.log(`[Vector] Deleting vectors for chatId=${chatId}`);
    const index = this.pinecone.Index(this.indexName);
    await index.deleteMany({ filter: { chatId } });
  }
}
