import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SemanticCache,
  SemanticCacheDocument,
} from './schemas/semantic-cache.schema';

@Injectable()
export class SemanticCacheService implements OnModuleInit {
  private readonly logger = new Logger(SemanticCacheService.name);
  private isAtlas = false;

  constructor(
    @InjectModel(SemanticCache.name)
    private cacheModel: Model<SemanticCacheDocument>,
  ) {
    // Check if we are connected to MongoDB Atlas
    // Accessing the connection string from the model's database connection
    const connection = this.cacheModel.db;
    const isAtlasUri =
      (connection as any)._connectionString?.includes('mongodb.net') ||
      (connection as any).host?.includes('mongodb.net');
    this.isAtlas = !!isAtlasUri;
  }

  async onModuleInit() {
    if (this.isAtlas) {
      await this.ensureVectorIndex();
    } else {
      this.logger.log(
        'Local MongoDB detected. Skipping Atlas Vector Search index creation. Manual similarity fallback will be used.',
      );
    }
  }

  private async ensureVectorIndex() {
    try {
      // Access the raw collection from Mongoose
      const collection = this.cacheModel.collection;

      // Check existing search indexes
      const indexes = await (collection as any).listSearchIndexes().toArray();
      const indexName = 'vector_index_v2';
      const indexExists = indexes.some((idx: any) => idx.name === indexName);

      if (!indexExists) {
        this.logger.log(
          `Creating MongoDB Atlas Vector Search Index "${indexName}"...`,
        );
        await (collection as any).createSearchIndex({
          name: indexName,
          type: 'vectorSearch',
          definition: {
            fields: [
              {
                numDimensions: 3072,
                path: 'embedding',
                similarity: 'cosine',
                type: 'vector',
              },
              {
                path: 'type',
                type: 'filter',
              },
              {
                path: 'chatId',
                type: 'filter',
              },
            ],
          },
        });
        this.logger.log(
          `Atlas Vector Search Index "${indexName}" creation initiated.`,
        );
      } else {
        this.logger.debug(
          `Atlas Vector Search Index "${indexName}" already exists.`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not automate Atlas Vector Index creation: ${error.message}. ` +
          'This is normal if you are not using MongoDB Atlas or lack administrative permissions. ' +
          'Manual index creation might be required in the Atlas dashboard.',
      );
    }
  }

  async findSimilarResponse(
    chatId: string,
    queryEmbedding: number[],
    threshold: number = 0.9,
  ): Promise<SemanticCacheDocument | null> {
    const startTime = Date.now();

    try {
      if (!this.isAtlas) {
        return this.findSimilarResponseManual(
          chatId,
          queryEmbedding,
          threshold,
        );
      }

      // Use MongoDB Atlas Vector Search
      const results = await this.cacheModel
        .aggregate([
          {
            $vectorSearch: {
              index: 'vector_index_v2',
              path: 'embedding',
              queryVector: queryEmbedding,
              numCandidates: 20,
              limit: 1,
              filter: {
                type: 'response',
                chatId: new Types.ObjectId(chatId),
              },
            },
          },
          {
            $addFields: {
              score: { $meta: 'vectorSearchScore' },
            },
          },
        ])
        .exec();

      const bestMatch = results.length > 0 ? results[0] : null;
      const duration = Date.now() - startTime;

      if (bestMatch && bestMatch.score > threshold) {
        this.logger.debug(
          `[Semantic Cache] MONGO VECTOR HIT (score: ${bestMatch.score.toFixed(4)}) in ${duration}ms`,
        );
        return bestMatch as SemanticCacheDocument;
      }
    } catch (error) {
      this.logger.warn(
        `MongoDB Vector Search failed, falling back to manual: ${error.message}`,
      );
      // Fallback to manual calculation if index is not ready or search fails
      return this.findSimilarResponseManual(chatId, queryEmbedding, threshold);
    }

    return null;
  }

  private async findSimilarResponseManual(
    chatId: string,
    queryEmbedding: number[],
    threshold: number,
  ): Promise<SemanticCacheDocument | null> {
    const entries = await this.cacheModel
      .find({
        type: 'response',
        chatId: new Types.ObjectId(chatId),
      })
      .sort({ createdAt: -1 })
      .limit(50)
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
    return bestMatch;
  }

  async findSimilarEmbedding(
    text: string,
    queryEmbedding: number[],
    threshold: number = 0.98,
  ): Promise<number[] | null> {
    try {
      if (!this.isAtlas) {
        throw new Error('Not on Atlas'); // Jump to fallback
      }

      const results = await this.cacheModel
        .aggregate([
          {
            $vectorSearch: {
              index: 'vector_index_v2',
              path: 'embedding',
              queryVector: queryEmbedding,
              numCandidates: 20,
              limit: 1,
              filter: { type: 'embedding' },
            },
          },
          {
            $addFields: {
              score: { $meta: 'vectorSearchScore' },
            },
          },
        ])
        .exec();

      if (results.length > 0 && results[0].score > threshold) {
        return results[0].embedding;
      }
    } catch (error) {
      // Fallback
      const entries = await this.cacheModel
        .find({ type: 'embedding' })
        .sort({ createdAt: -1 })
        .limit(100)
        .exec();

      for (const entry of entries) {
        const similarity = this.cosineSimilarity(
          queryEmbedding,
          entry.embedding,
        );
        if (similarity > threshold) {
          return entry.embedding;
        }
      }
    }

    return null;
  }

  async save(
    data: Partial<SemanticCache> & { type: 'response' | 'embedding' },
  ): Promise<void> {
    try {
      if (data.embedding) {
        this.logger.debug(
          `Saving entry with embedding dimension: ${data.embedding.length}`,
        );
      }
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
