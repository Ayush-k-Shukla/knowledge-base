import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiService } from '../ai/ai.service';
import { VectorService } from '../vector/vector.service';
import { DocumentDocument, DocumentItem } from './schemas/document.schema';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdf = require('pdf-parse');

@Injectable()
export class DocumentService {
  constructor(
    private aiService: AiService,
    private vectorService: VectorService,
    @InjectModel(DocumentItem.name) private documentModel: Model<DocumentDocument>,
  ) {}

  async processDocument(file: Express.Multer.File): Promise<void> {
    const dataBuffer = file.buffer;
    const pdfData = await pdf(dataBuffer);
    const text = pdfData.text;

    // Simple chunking strategy
    const chunks = this.chunkText(text, 1000, 200);

    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await this.aiService.generateEmbedding(chunk);
      vectors.push({
        id: `${file.originalname}-${i}`,
        values: embedding,
        metadata: {
          text: chunk,
          source: file.originalname,
          chunkIndex: i,
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
      { filename: file.originalname },
      { filename: file.originalname, uploadedAt: new Date() },
      { upsert: true, new: true },
    );
  }

  async findAll(): Promise<DocumentItem[]> {
    return this.documentModel.find().sort({ uploadedAt: -1 }).exec();
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

