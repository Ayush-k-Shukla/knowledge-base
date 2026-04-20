import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AiService } from '../ai/ai.service';
import {
  ChatSession,
  ChatSessionDocument,
} from '../chat/schemas/chat-session.schema';
import { VectorService } from '../vector/vector.service';
import { DocumentDocument, DocumentItem } from './schemas/document.schema';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdf = require('pdf-parse');

@Injectable()
export class DocumentService {
  constructor(
    private aiService: AiService,
    private vectorService: VectorService,
    @InjectModel(DocumentItem.name)
    private documentModel: Model<DocumentDocument>,
    @InjectModel(ChatSession.name)
    private chatSessionModel: Model<ChatSessionDocument>,
  ) {}

  async processDocument(
    chatId: string,
    file: Express.Multer.File,
    userId: string,
  ): Promise<void> {
    await this.ensureOwnership(chatId, userId);

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

    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await this.aiService.generateEmbedding(chunk);
      vectors.push({
        id: `${chatId}-${file.originalname}-${i}`,
        values: embedding,
        metadata: {
          text: chunk,
          source: file.originalname,
          chunkIndex: i,
          chatId,
        },
      });

      // Upsert in batches of 50 to avoid payload limits
      if (vectors.length >= 50) {
        await this.vectorService.upsert([...vectors]);
        vectors.length = 0;
      }
    }

    if (vectors.length > 0) {
      await this.vectorService.upsert(vectors);
    }

    // Save metadata to MongoDB
    await this.documentModel.findOneAndUpdate(
      { filename: file.originalname, chatId: new Types.ObjectId(chatId) },
      {
        filename: file.originalname,
        chatId: new Types.ObjectId(chatId),
        uploadedAt: new Date(),
      },
      { upsert: true, new: true },
    );
  }

  async findAll(chatId: string, userId: string): Promise<DocumentItem[]> {
    await this.ensureOwnership(chatId, userId);
    return this.documentModel
      .find({ chatId: new Types.ObjectId(chatId) })
      .sort({ uploadedAt: -1 })
      .exec();
  }

  private async ensureOwnership(chatId: string, userId: string) {
    const session = await this.chatSessionModel.findOne({
      _id: new Types.ObjectId(chatId),
      userId: new Types.ObjectId(userId),
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
