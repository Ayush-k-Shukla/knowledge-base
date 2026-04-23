import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AiService, AnswerWithCitations } from '../ai/ai.service';
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

    // 2. Query Rewriting Layer: Rewrite query into 3 optimized queries
    const queryRewrite = await this.aiService.rewriteQuery(question);

    // 3. Run vector search for all 3 rewritten queries
    const allMatches = [];
    for (const rewrittenQuery of queryRewrite.rewrittenQueries) {
      const queryEmbedding =
        await this.aiService.generateEmbedding(rewrittenQuery);
      const matches = await this.vectorService.query(queryEmbedding, 5, {
        chatId,
      });
      allMatches.push(...matches);
    }

    // 4. Merge and deduplicate results based on chunk ID
    const uniqueMatches = this.mergeAndDeduplicateMatches(allMatches);

    // 5. Prepare context chunks with IDs for citation
    const contextChunks = uniqueMatches
      .slice(0, 10)
      .map((match, index) => ({
        id: match.id || `chunk_${index}`,
        sourceId:
          match.metadata?.sourceId || match.metadata?.documentId || 'unknown',
        text: match.metadata?.text || '',
      }))
      .filter((chunk) => chunk.text);

    // 6. Generate answer with citations
    const answerWithCitations =
      await this.aiService.generateAnswerWithCitations(question, contextChunks);

    // 7. Format the final answer with citations and snippets
    const formattedAnswer =
      this.formatAnswerWithCitationsAndSnippets(answerWithCitations);

    // 8. Save bot answer
    await new this.messageModel({
      chatId: new Types.ObjectId(chatId),
      role: 'bot',
      content: formattedAnswer,
    }).save();

    return formattedAnswer;
  }

  private mergeAndDeduplicateMatches(matches: any[]): any[] {
    const seen = new Map<string, any>();
    const uniqueMatches: any[] = [];

    for (const match of matches) {
      const chunkId =
        match.id ||
        match.metadata?.chunkId ||
        match.metadata?.text?.substring(0, 100);
      if (!seen.has(chunkId)) {
        seen.set(chunkId, match);
        uniqueMatches.push(match);
      }
    }

    // Sort by score (descending) and return top results
    return uniqueMatches
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 15); // Keep more results for better coverage
  }

  private formatAnswerWithCitationsAndSnippets(
    answerWithCitations: AnswerWithCitations,
  ): string {
    let formattedAnswer = answerWithCitations.answer;

    const citationMap = new Map<string, number>();
    const orderedCitations: Array<{
      key: string;
      sourceId: string;
      chunkId: string;
      sentences: string[];
    }> = [];

    answerWithCitations.citations.forEach((citation) => {
      const key = `[${citation.sourceId}:${citation.chunkId}]`;
      if (!citationMap.has(key)) {
        citationMap.set(key, citationMap.size + 1);
        orderedCitations.push({
          key,
          sourceId: citation.sourceId,
          chunkId: citation.chunkId,
          sentences: citation.relevantSentences,
        });
      }
    });

    citationMap.forEach((index, key) => {
      formattedAnswer = formattedAnswer.split(key).join(`[${index}]`);
    });

    if (orderedCitations.length > 0) {
      formattedAnswer += '\n\n### Sources\n';
      orderedCitations.forEach((citation, i) => {
        formattedAnswer += `${i + 1}. ${citation.key}\n`;
        citation.sentences.forEach((sentence) => {
          formattedAnswer += `   - ${sentence}\n`;
        });
      });
    }

    return formattedAnswer;
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
