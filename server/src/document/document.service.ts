import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiService } from '../ai/ai.service';
import {
  ChatSession,
  ChatSessionDocument,
} from '../chat/schemas/chat-session.schema';
import { toObjectId } from '../utils/object-id.util';
import { VectorService } from '../vector/vector.service';
import { DocumentDocument, DocumentItem } from './schemas/document.schema';
import { Chunk, ChunkDocument } from '../chat/schemas/chunk.schema';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdf = require('pdf-parse');

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    private aiService: AiService,
    private vectorService: VectorService,
    @InjectModel(DocumentItem.name)
    private documentModel: Model<DocumentDocument>,
    @InjectModel(ChatSession.name)
    private chatSessionModel: Model<ChatSessionDocument>,
    @InjectModel(Chunk.name) private chunkModel: Model<ChunkDocument>,
  ) {}

  async processDocument(
    chatId: string,
    file: Express.Multer.File,
    userId: string,
  ): Promise<void> {
    this.logger.log(`[Document] Processing upload ${file.originalname} for chatId=${chatId} userId=${userId}`);
    await this.ensureOwnership(chatId, userId);
    this.logger.debug(`[Document] Ownership verified for chatId=${chatId}`);

    const dataBuffer = file.buffer;
    let text = '';

    if (
      file.mimetype === 'application/pdf' ||
      file.originalname.endsWith('.pdf')
    ) {
      const pdfData = await pdf(dataBuffer);
      text = pdfData.text;
    } else {
      text = dataBuffer.toString('utf-8');
    }

    // Simple chunking strategy
    const chunks = this.chunkText(text, 1000, 200);
    this.logger.debug(
      `[Document ${file.originalname}] Created ${chunks.length} chunks for processing`,
    );

    // Generate embeddings in parallel
    this.logger.debug(
      `[Document ${file.originalname}] Starting parallel embedding generation for ${chunks.length} chunks`,
    );
    const embeddingStartTime = Date.now();

    const embeddingPromises = chunks.map((chunk) =>
      this.aiService.generateEmbedding(chunk),
    );
    const embeddings = await Promise.all(embeddingPromises);

    const embeddingTime = Date.now() - embeddingStartTime;
    this.logger.debug(
      `[Document ${file.originalname}] Parallel embedding generation completed in ${embeddingTime}ms`,
    );

    const vectors = chunks.map((chunk, i) => ({
      id: `${chatId}-${file.originalname}-${i}`,
      values: embeddings[i],
      metadata: {
        text: chunk,
        source: file.originalname,
        chunkIndex: i,
        chatId,
      },
    }));

    // Upsert in batches of 50 to avoid payload limits
    this.logger.debug(
      `[Document ${file.originalname}] Starting vector upsert for ${vectors.length} vectors`,
    );
    const upsertStartTime = Date.now();

    for (let i = 0; i < vectors.length; i += 50) {
      const batch = vectors.slice(i, i + 50);
      await this.vectorService.upsert(batch);
    }

    const upsertTime = Date.now() - upsertStartTime;
    this.logger.debug(
      `[Document ${file.originalname}] Vector upsert completed in ${upsertTime}ms`,
    );

    // Save chunks to MongoDB for keyword search
    this.logger.debug(
      `[Document ${file.originalname}] Saving chunks to MongoDB for hybrid search`,
    );
    const mongoChunks = chunks.map((chunk, i) => ({
      chatId: toObjectId(chatId),
      text: chunk,
      source: file.originalname,
      chunkIndex: i,
      metadata: {
        filename: file.originalname,
        chatId,
      },
    }));

    await this.chunkModel.insertMany(mongoChunks);
    this.logger.debug(
      `[Document] Inserted ${mongoChunks.length} chunks for file ${file.originalname} into MongoDB`,
    );

    // Save metadata to MongoDB
    await this.documentModel.findOneAndUpdate(
      { filename: file.originalname, chatId: toObjectId(chatId) },
      {
        filename: file.originalname,
        chatId: toObjectId(chatId),
        uploadedAt: new Date(),
      },
      { upsert: true, new: true },
    );
    this.logger.log(`[Document] Completed processing ${file.originalname} for chatId=${chatId}`);
  }

  async findAll(chatId: string, userId: string): Promise<DocumentItem[]> {
    this.logger.debug(`[Document] Retrieving documents for chatId=${chatId} userId=${userId}`);
    await this.ensureOwnership(chatId, userId);
    const documents = await this.documentModel
      .find({ chatId: toObjectId(chatId) })
      .sort({ uploadedAt: -1 })
      .exec();
    this.logger.debug(`[Document] Retrieved ${documents.length} documents for chatId=${chatId}`);
    return documents;

  private async ensureOwnership(chatId: string, userId: string) {
    this.logger.debug(`[Document] Verifying ownership chatId=${chatId} userId=${userId}`);
    const session = await this.chatSessionModel.findOne({
      _id: toObjectId(chatId),
      userId: toObjectId(userId),
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }
  }

  private chunkText(text: string, size: number, overlap: number): string[] {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + size, text.length);
      chunks.push(text.substring(start, end));
      start += size - overlap;
    }
    return chunks;
  }
}
