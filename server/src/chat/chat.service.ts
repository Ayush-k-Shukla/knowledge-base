import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SemanticCacheService } from 'src/ai/semantic-cache.service';
import { AiService, AnswerWithCitations } from '../ai/ai.service';
import {
  DocumentDocument,
  DocumentItem,
} from '../document/schemas/document.schema';
import { toObjectId } from '../utils/object-id.util';
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
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private aiService: AiService,
    private vectorService: VectorService,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    @InjectModel(ChatSession.name)
    private chatSessionModel: Model<ChatSessionDocument>,
    @InjectModel(DocumentItem.name)
    private documentModel: Model<DocumentDocument>,
    @InjectModel(WebsiteItem.name) private websiteModel: Model<WebsiteDocument>,
    private semanticCache: SemanticCacheService,
  ) {}

  async createSession(userId: string): Promise<ChatSessionDocument> {
    return new this.chatSessionModel({
      userId: toObjectId(userId),
    }).save();
  }

  async getSessions(userId: string): Promise<ChatSession[]> {
    return this.chatSessionModel
      .find({ userId: toObjectId(userId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  async askQuestion(
    chatId: string,
    question: string,
    userId: string,
  ): Promise<{
    answer: string;
    confidenceScore?: number;
    confidenceReasoning?: string;
  }> {
    this.logger.log(`[Chat ${chatId}] Processing question: "${question}"`);
    const session = await this.ensureOwnership(chatId, userId);
    const chatObjectId = toObjectId(chatId);

    this.logger.debug(`[Chat ${chatId}] Step 1: Saving user question`);
    await this.saveMessage(chatObjectId, 'user', question);

    this.logger.debug(`[Chat ${chatId}] Step 1.5: Checking semantic cache`);
    const questionEmbedding = await this.aiService.generateEmbedding(question);
    const cachedResponse = await this.semanticCache.findSimilarResponse(
      chatId,
      questionEmbedding,
    );

    if (cachedResponse) {
      this.logger.log(`[Chat ${chatId}] Semantic Cache HIT! Reusing answer.`);
      const response = {
        answer: cachedResponse.answer!,
        confidenceScore: cachedResponse.confidenceScore,
        confidenceReasoning: cachedResponse.confidenceReasoning,
      };

      await this.saveMessage(
        chatObjectId,
        'bot',
        response.answer,
        response.confidenceScore,
        response.confidenceReasoning,
      );

      return response;
    }

    this.logger.debug(`[Chat ${chatId}] Step 2: Rewriting query`);
    const queryRewrite = await this.aiService.rewriteQuery(question);

    const rerankedMatches = await this.retrieveAndRankMatches(
      chatId,
      question,
      queryRewrite.rewrittenQueries,
    );

    this.logger.debug(`[Chat ${chatId}] Step 5: Preparing context chunks`);
    let contextChunks = this.buildContextChunks(rerankedMatches);

    const routingResult = await this.routeQuestion(question, contextChunks);
    if (routingResult.action === 'ASK_CLARIFICATION') {
      const botResponse =
        routingResult.message || 'Could you please clarify your question?';
      await this.saveMessage(chatObjectId, 'bot', botResponse);
      return { answer: botResponse };
    }

    contextChunks = routingResult.contextChunks;

    this.logger.debug(
      `[Chat ${chatId}] Step 6: Generating answer with citations`,
    );
    const answerWithCitations =
      await this.aiService.generateAnswerWithCitations(question, contextChunks);

    this.logger.debug(`[Chat ${chatId}] Step 7: Formatting final answer`);
    const formattedAnswer =
      this.formatAnswerWithCitationsAndSnippets(answerWithCitations);

    this.logger.debug(`[Chat ${chatId}] Step 8: Calculating confidence score`);
    const confidence = await this.aiService.calculateConfidenceScore(
      question,
      formattedAnswer,
      contextChunks,
    );

    this.logger.debug(`[Chat ${chatId}] Step 9: Saving bot answer`);
    await this.saveMessage(
      chatObjectId,
      'bot',
      formattedAnswer,
      confidence.score,
      confidence.reasoning,
    );

    this.logger.debug(`[Chat ${chatId}] Step 10: Saving to semantic cache`);
    await this.semanticCache.save({
      type: 'response',
      chatId: chatObjectId,
      input: question,
      embedding: questionEmbedding,
      answer: formattedAnswer,
      confidenceScore: confidence.score,
      confidenceReasoning: confidence.reasoning,
    });

    if (session.title === 'New Chat') {
      await this.generateChatTitleIfDefault(chatObjectId, chatId);
    }

    this.logger.log(`[Chat ${chatId}] Request completed successfully`);
    return {
      answer: formattedAnswer,
      confidenceScore: confidence.score,
      confidenceReasoning: confidence.reasoning,
    };
  }

  private async saveMessage(
    chatObjectId: Types.ObjectId,
    role: 'user' | 'bot',
    content: string,
    confidenceScore?: number,
    confidenceReasoning?: string,
  ) {
    return new this.messageModel({
      chatId: chatObjectId,
      role,
      content,
      confidenceScore,
      confidenceReasoning,
    }).save();
  }

  private async retrieveAndRankMatches(
    chatId: string,
    question: string,
    rewrittenQueries: string[],
  ): Promise<any[]> {
    this.logger.debug(
      `[Chat ${chatId}] Step 3: Running parallel vector search for ${rewrittenQueries.length} rewritten queries`,
    );
    const retrievalStartTime = Date.now();

    const searchResults = await Promise.all(
      rewrittenQueries.map(async (rewrittenQuery) => {
        try {
          const embedding =
            await this.aiService.generateEmbedding(rewrittenQuery);
          return await this.vectorService.query(embedding, 5, { chatId });
        } catch (error: any) {
          this.logger.warn(
            `[Chat ${chatId}] Failed to process rewritten query "${rewrittenQuery}": ${error.message}`,
          );
          return [];
        }
      }),
    );

    const allMatches = searchResults.flat();
    const retrievalTime = Date.now() - retrievalStartTime;

    this.logger.debug(
      `[Chat ${chatId}] Parallel retrieval completed in ${retrievalTime}ms. Total matches: ${allMatches.length} from ${searchResults.length} queries`,
    );

    // 4. Merge and deduplicate results based on chunk ID
    this.logger.debug(
      `[Chat ${chatId}] Step 4: Merging and deduplicating matches`,
    );
    const uniqueMatches = this.mergeAndDeduplicateMatches(allMatches);

    this.logger.debug(
      `[Chat ${chatId}] Step 4.5: Re-ranking ${uniqueMatches.length} matches with Cohere`,
    );
    return this.aiService.rerankChunks(question, uniqueMatches);
  }

  private buildContextChunks(rerankedMatches: any[]): any[] {
    return rerankedMatches
      .map((match, index) => ({
        id: match.id || `chunk_${index}`,
        sourceId:
          match.metadata?.source ||
          match.metadata?.sourceId ||
          match.metadata?.documentId ||
          'unknown',
        text: match.metadata?.text || '',
        title: match.metadata?.source || match.metadata?.title || '',
      }))
      .filter((chunk) => chunk.text);
  }

  private async routeQuestion(
    question: string,
    contextChunks: any[],
  ): Promise<{
    action: 'ANSWER' | 'ASK_CLARIFICATION';
    contextChunks: any[];
    message?: string;
  }> {
    this.logger.debug(
      `[Chat] Step 5.5: Evaluating context sufficiency (Agentic Routing)`,
    );
    const evaluation = await this.aiService.evaluateContext(
      question,
      contextChunks,
    );
    this.logger.log(
      `[Chat] Routing Action: ${evaluation.action} - ${evaluation.reasoning}`,
    );

    if (evaluation.action === 'ASK_CLARIFICATION') {
      return {
        action: 'ASK_CLARIFICATION',
        contextChunks,
        message:
          evaluation.message || 'Could you please clarify your question?',
      };
    }

    if (evaluation.action === 'WEB_SEARCH') {
      this.logger.debug(
        `[Chat] Performing web search for: ${evaluation.message}`,
      );
      const searchQuery = evaluation.message || question;
      const webResults = await this.aiService.performWebSearch(searchQuery);

      if (webResults && webResults.length > 0) {
        const enrichedChunks = webResults.map((res, idx) => ({
          id: `Web_${idx}`,
          sourceId: 'WebSearch',
          text: `Title: ${res.title}\nInformation: ${res.snippet}`,
          title: res.title,
        }));
        this.logger.debug(
          `[Chat] Appended ${webResults.length} web search results to context`,
        );
        return {
          action: 'ANSWER',
          contextChunks: [...contextChunks, ...enrichedChunks],
        };
      }
    }

    return { action: 'ANSWER', contextChunks };
  }

  private async generateChatTitleIfDefault(
    chatObjectId: Types.ObjectId,
    chatId: string,
  ) {
    const messages = await this.messageModel
      .find({ chatId: chatObjectId })
      .sort({ createdAt: 1 })
      .exec();

    if (messages.length < 2) {
      return;
    }

    const title = await this.aiService.generateChatTitle(
      messages.map((m) => ({ role: m.role, content: m.content })),
    );

    await this.chatSessionModel.findByIdAndUpdate(chatId, { title });
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
      title?: string;
      sentences: string[];
    }> = [];

    answerWithCitations.citations.forEach((citation) => {
      const key = citation.originalMatch;
      if (!citationMap.has(key)) {
        citationMap.set(key, citationMap.size + 1);
        orderedCitations.push({
          key,
          sourceId: citation.sourceId,
          chunkId: citation.chunkId,
          title: citation.title,
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
        let sourceLabel = 'Source';
        if (citation.sourceId === 'WebSearch') {
          sourceLabel = `🌐 Web Search: ${citation.title || citation.chunkId}`;
        } else if (citation.title) {
          sourceLabel = `📄 ${citation.title}`;
        } else if (citation.sourceId === 'unknown') {
          sourceLabel = `📄 Uploaded Document`;
        } else {
          sourceLabel = `📄 Document (${citation.sourceId.substring(0, 8)})`;
        }

        formattedAnswer += `${i + 1}. **${sourceLabel}**\n`;
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
      .find({ chatId: toObjectId(chatId) })
      .sort({ createdAt: 1 })
      .exec();
  }

  async deleteSession(
    chatId: string,
    userId: string,
  ): Promise<{ deleted: boolean }> {
    const session = await this.chatSessionModel.findOneAndDelete({
      _id: toObjectId(chatId),
      userId: toObjectId(userId),
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    await Promise.all([
      this.messageModel.deleteMany({ chatId: toObjectId(chatId) }).exec(),
      this.documentModel.deleteMany({ chatId: toObjectId(chatId) }).exec(),
      this.websiteModel.deleteMany({ chatId: toObjectId(chatId) }).exec(),
      this.vectorService.deleteByChatId(chatId),
    ]);

    return { deleted: true };
  }

  private async ensureOwnership(
    chatId: string,
    userId: string,
  ): Promise<ChatSessionDocument> {
    const session = await this.chatSessionModel.findOne({
      _id: toObjectId(chatId),
      userId: toObjectId(userId),
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }
    return session;
  }
}
