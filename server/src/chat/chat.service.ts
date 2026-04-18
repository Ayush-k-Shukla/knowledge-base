import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiService } from '../ai/ai.service';
import { VectorService } from '../vector/vector.service';
import { Message, MessageDocument } from './schemas/message.schema';

@Injectable()
export class ChatService {
  constructor(
    private aiService: AiService,
    private vectorService: VectorService,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
  ) {}

  async askQuestion(question: string): Promise<string> {
    // 1. Save user question
    await new this.messageModel({ role: 'user', content: question }).save();

    // 2. Generate embedding for the question
    const queryEmbedding = await this.aiService.generateEmbedding(question);

    // 3. Query vector store for related chunks
    const matches = await this.vectorService.query(queryEmbedding, 5);

    // 4. Construct context from matches
    const context = matches
      .map((match) => match.metadata?.text)
      .filter((text) => !!text)
      .join('\n\n---\n\n');

    // 5. Generate answer using Gemini
    const answer = await this.aiService.generateAnswer(question, context);

    // 6. Save bot answer
    await new this.messageModel({ role: 'bot', content: answer }).save();

    return answer;
  }

  async getHistory(): Promise<Message[]> {
    return this.messageModel.find().sort({ createdAt: 1 }).exec();
  }
}

