import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pinecone } from '@pinecone-database/pinecone';

@Injectable()
export class VectorService implements OnModuleInit {
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
    const index = this.pinecone.Index(this.indexName);
    // SDK 7.x requires an object with 'records'
    await index.upsert({ records: vectors });
  }

  async query(vector: number[], topK: number = 5) {
    const index = this.pinecone.Index(this.indexName);
    const result = await index.query({
      vector,
      topK,
      includeMetadata: true,
    });
    return result.matches;
  }
}
