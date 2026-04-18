import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AiService } from '../ai/ai.service';
import { VectorService } from '../vector/vector.service';
import { Message, MessageDocument } from './schemas/message.schema';
import { ChatSession, ChatSessionDocument } from './schemas/chat-session.schema';

@Injectable()
export class ChatService {
  constructor(
    private aiService: AiService,
    private vectorService: VectorService,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    @InjectModel(ChatSession.name) private chatSessionModel: Model<ChatSessionDocument>,
  ) {}

  async createSession(): Promise<ChatSessionDocument> {
    return new this.chatSessionModel().save();
  }

  async getSessions(): Promise<ChatSession[]> {
    return this.chatSessionModel.find().sort({ createdAt: -1 }).exec();
  }

  async askQuestion(chatId: string, question: string): Promise<string> {
    // 1. Save user question
    await new this.messageModel({ chatId: new Types.ObjectId(chatId), role: 'user', content: question }).save();

    // 2. Generate embedding for the question
    const queryEmbedding = await this.aiService.generateEmbedding(question);

    // 3. Query vector store for related chunks within this specific chat session
    const matches = await this.vectorService.query(queryEmbedding, 5, { chatId });

    // 4. Construct context from matches
    const context = matches
      .map((match) => match.metadata?.text)
      .filter((text) => !!text)
      .join('\n\n---\n\n');

    // 5. Generate answer using Gemini
    const answer = await this.aiService.generateAnswer(question, context);

    // 6. Save bot answer
    await new this.messageModel({ chatId: new Types.ObjectId(chatId), role: 'bot', content: answer }).save();

    return answer;
  }

  async getHistory(chatId: string): Promise<Message[]> {
    return this.messageModel.find({ chatId: new Types.ObjectId(chatId) }).sort({ createdAt: 1 }).exec();
  }
}

