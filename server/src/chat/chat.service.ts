import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AiService } from '../ai/ai.service';
import {
  DocumentDocument,
  DocumentItem,
} from '../document/schemas/document.schema';
import { VectorService } from '../vector/vector.service';
import {
  WebsiteDocument,
  WebsiteItem,
} from '../website/schemas/website.schema';
import {
  ChatSession,
  ChatSessionDocument,
} from './schemas/chat-session.schema';
import { Message, MessageDocument } from './schemas/message.schema';

@Injectable()
export class ChatService {
  constructor(
    private aiService: AiService,
    private vectorService: VectorService,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    @InjectModel(ChatSession.name)
    private chatSessionModel: Model<ChatSessionDocument>,
    @InjectModel(DocumentItem.name)
    private documentModel: Model<DocumentDocument>,
    @InjectModel(WebsiteItem.name) private websiteModel: Model<WebsiteDocument>,
  ) {}

  async createSession(userId: string): Promise<ChatSessionDocument> {
    return new this.chatSessionModel({
      userId: new Types.ObjectId(userId),
    }).save();
  }

  async getSessions(userId: string): Promise<ChatSession[]> {
    return this.chatSessionModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  async askQuestion(
    chatId: string,
    question: string,
    userId: string,
  ): Promise<string> {
    await this.ensureOwnership(chatId, userId);

    // 1. Save user question
    await new this.messageModel({
      chatId: new Types.ObjectId(chatId),
      role: 'user',
      content: question,
    }).save();

    // 2. Generate embedding for the question
    const queryEmbedding = await this.aiService.generateEmbedding(question);

    // 3. Query vector store for related chunks within this specific chat session
    const matches = await this.vectorService.query(queryEmbedding, 5, {
      chatId,
    });

    // 4. Construct context from matches
    const context = matches
      .map((match) => match.metadata?.text)
      .filter((text) => !!text)
      .join('\n\n---\n\n');

    // 5. Generate answer using Gemini
    const answer = await this.aiService.generateAnswer(question, context);

    // 6. Save bot answer
    await new this.messageModel({
      chatId: new Types.ObjectId(chatId),
      role: 'bot',
      content: answer,
    }).save();

    return answer;
  }

  async getHistory(chatId: string, userId: string): Promise<Message[]> {
    await this.ensureOwnership(chatId, userId);
    return this.messageModel
      .find({ chatId: new Types.ObjectId(chatId) })
      .sort({ createdAt: 1 })
      .exec();
  }

  async deleteSession(
    chatId: string,
    userId: string,
  ): Promise<{ deleted: boolean }> {
    const session = await this.chatSessionModel.findOneAndDelete({
      _id: new Types.ObjectId(chatId),
      userId: new Types.ObjectId(userId),
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    await Promise.all([
      this.messageModel
        .deleteMany({ chatId: new Types.ObjectId(chatId) })
        .exec(),
      this.documentModel
        .deleteMany({ chatId: new Types.ObjectId(chatId) })
        .exec(),
      this.websiteModel
        .deleteMany({ chatId: new Types.ObjectId(chatId) })
        .exec(),
      this.vectorService.deleteByChatId(chatId),
    ]);

    return { deleted: true };
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
}
