import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  ): Promise<{
    answer: string;
    confidenceScore?: number;
    confidenceReasoning?: string;
  }> {
    this.logger.log(`[Chat ${chatId}] Processing question: "${question}"`);
    const session = await this.ensureOwnership(chatId, userId);

    // 1. Save user question
    this.logger.debug(`[Chat ${chatId}] Step 1: Saving user question`);
    await new this.messageModel({
      chatId: new Types.ObjectId(chatId),
      role: 'user',
      content: question,
    }).save();

    // 2. Query Rewriting Layer: Rewrite query into 3 optimized queries
    this.logger.debug(`[Chat ${chatId}] Step 2: Rewriting query`);
    const queryRewrite = await this.aiService.rewriteQuery(question);

    // 3. Run vector search for all 3 rewritten queries
    this.logger.debug(`[Chat ${chatId}] Step 3: Running vector search`);
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
    this.logger.debug(
      `[Chat ${chatId}] Step 4: Merging and deduplicating matches`,
    );
    const uniqueMatches = this.mergeAndDeduplicateMatches(allMatches);

    // 4.5. Re-rank the deduplicated matches using Cohere
    this.logger.debug(
      `[Chat ${chatId}] Step 4.5: Re-ranking ${uniqueMatches.length} matches with Cohere`,
    );
    const rerankedMatches = await this.aiService.rerankChunks(
      question,
      uniqueMatches,
    );

    // 5. Prepare context chunks with IDs for citation
    this.logger.debug(`[Chat ${chatId}] Step 5: Preparing context chunks`);
    const contextChunks: any[] = rerankedMatches
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

    // 5.5. Agentic Routing Layer
    this.logger.debug(
      `[Chat ${chatId}] Step 5.5: Evaluating context sufficiency (Agentic Routing)`,
    );
    const evaluation = await this.aiService.evaluateContext(
      question,
      contextChunks,
    );
    this.logger.log(
      `[Chat ${chatId}] Routing Action: ${evaluation.action} - ${evaluation.reasoning}`,
    );

    if (evaluation.action === 'ASK_CLARIFICATION') {
      this.logger.debug(
        `[Chat ${chatId}] Asking for clarification: ${evaluation.message}`,
      );
      const botResponse =
        evaluation.message || 'Could you please clarify your question?';
      await new this.messageModel({
        chatId: new Types.ObjectId(chatId),
        role: 'bot',
        content: botResponse,
      }).save();
      return { answer: botResponse };
    }

    if (evaluation.action === 'WEB_SEARCH') {
      this.logger.debug(
        `[Chat ${chatId}] Performing web search for: ${evaluation.message}`,
      );
      const searchQuery = evaluation.message || question;
      const webResults = await this.aiService.performWebSearch(searchQuery);

      // We append web results as individual chunks
      if (webResults && webResults.length > 0) {
        webResults.forEach((res, idx) => {
          contextChunks.push({
            id: `Web_${idx}`,
            sourceId: 'WebSearch',
            text: `Title: ${res.title}\nInformation: ${res.snippet}`,
            title: res.title,
          });
        });
        this.logger.debug(
          `[Chat ${chatId}] Appended ${webResults.length} web search results to context`,
        );
      }
    }

    // 6. Generate answer with citations
    this.logger.debug(
      `[Chat ${chatId}] Step 6: Generating answer with citations`,
    );
    const answerWithCitations =
      await this.aiService.generateAnswerWithCitations(question, contextChunks);

    // 7. Format the final answer with citations and snippets
    this.logger.debug(`[Chat ${chatId}] Step 7: Formatting final answer`);
    const formattedAnswer =
      this.formatAnswerWithCitationsAndSnippets(answerWithCitations);

    // 8. Calculate Confidence Score
    this.logger.debug(`[Chat ${chatId}] Step 8: Calculating confidence score`);
    const confidence = await this.aiService.calculateConfidenceScore(
      question,
      formattedAnswer,
      contextChunks,
    );

    // 9. Save bot answer
    this.logger.debug(`[Chat ${chatId}] Step 9: Saving bot answer`);
    await new this.messageModel({
      chatId: new Types.ObjectId(chatId),
      role: 'bot',
      content: formattedAnswer,
      confidenceScore: confidence.score,
      confidenceReasoning: confidence.reasoning,
    }).save();

    // Generate chat title if it's still default
    if (session.title === 'New Chat') {
      const messages = await this.messageModel
        .find({ chatId: new Types.ObjectId(chatId) })
        .sort({ createdAt: 1 })
        .exec();
      if (messages.length >= 2) {
        // At least user question and bot answer
        const title = await this.aiService.generateChatTitle(
          messages.map((m) => ({ role: m.role, content: m.content })),
        );
        await this.chatSessionModel.findByIdAndUpdate(chatId, { title });
      }
    }

    this.logger.log(`[Chat ${chatId}] Request completed successfully`);
    return {
      answer: formattedAnswer,
      confidenceScore: confidence.score,
      confidenceReasoning: confidence.reasoning,
    };
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

  private async ensureOwnership(
    chatId: string,
    userId: string,
  ): Promise<ChatSessionDocument> {
    const session = await this.chatSessionModel.findOne({
      _id: new Types.ObjectId(chatId),
      userId: new Types.ObjectId(userId),
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }
    return session;
  }
}
