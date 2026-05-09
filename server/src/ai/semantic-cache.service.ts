import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SemanticCache,
  SemanticCacheDocument,
} from './schemas/semantic-cache.schema';

@Injectable()
export class SemanticCacheService {
  private readonly logger = new Logger(SemanticCacheService.name);

  constructor(
    @InjectModel(SemanticCache.name)
    private cacheModel: Model<SemanticCacheDocument>,
  ) {}

  async findSimilarResponse(
    chatId: string,
    queryEmbedding: number[],
    threshold: number = 0.9,
  ): Promise<SemanticCacheDocument | null> {
    const startTime = Date.now();

    // Find recent cache entries for this chat
    const entries = await this.cacheModel
      .find({
        type: 'response',
        chatId: new Types.ObjectId(chatId),
      })
      .sort({ createdAt: -1 })
      .limit(50) // Only check the 50 most recent queries for performance
      .exec();

    let bestMatch: SemanticCacheDocument | null = null;
    let maxSimilarity = -1;

    for (const entry of entries) {
      const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity > threshold && similarity > maxSimilarity) {
        maxSimilarity = similarity;
        bestMatch = entry;
      }
    }

    const duration = Date.now() - startTime;
    if (bestMatch) {
      this.logger.debug(
        `[Semantic Cache] HIT for response (similarity: ${maxSimilarity.toFixed(4)}) in ${duration}ms`,
      );
    } else {
      this.logger.debug(`[Semantic Cache] MISS for response in ${duration}ms`);
    }

    return bestMatch;
  }

  async findSimilarEmbedding(
    text: string,
    queryEmbedding: number[], // We need the embedding to compare, or we search by text
    threshold: number = 0.98,
  ): Promise<number[] | null> {
    // For embeddings, we can also check global cache
    const entries = await this.cacheModel
      .find({ type: 'embedding' })
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();

    for (const entry of entries) {
      const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity > threshold) {
        return entry.output as number[];
      }
    }

    return null;
  }

  async save(
    data: Partial<SemanticCache> & { type: 'response' | 'embedding' },
  ): Promise<void> {
    try {
      await new this.cacheModel(data).save();
    } catch (error) {
      this.logger.error(`Failed to save to semantic cache: ${error.message}`);
    }
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    return isNaN(similarity) ? 0 : similarity;
  }
}
