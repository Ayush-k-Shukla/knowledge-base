import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
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
import { Chunk, ChunkDocument } from './schemas/chunk.schema';
import { Message, MessageDocument } from './schemas/message.schema';

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);
  private isAtlas = false;
  private readonly CHUNK_SEARCH_INDEX = 'chunk_search_index';

  constructor(
    private aiService: AiService,
    private vectorService: VectorService,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    @InjectModel(ChatSession.name)
    private chatSessionModel: Model<ChatSessionDocument>,
    @InjectModel(DocumentItem.name)
    private documentModel: Model<DocumentDocument>,
    @InjectModel(WebsiteItem.name) private websiteModel: Model<WebsiteDocument>,
    @InjectModel(Chunk.name) private chunkModel: Model<ChunkDocument>,
    private semanticCache: SemanticCacheService,
  ) {
    const connection = this.chunkModel.db;
    const isAtlasUri =
      (connection as any)._connectionString?.includes('mongodb.net') ||
      (connection as any).host?.includes('mongodb.net');
    this.isAtlas = !!isAtlasUri;
  }

  async onModuleInit() {
    if (this.isAtlas) {
      await this.ensureSearchIndex();
    }
  }

  private async ensureSearchIndex() {
    try {
      const collection = this.chunkModel.collection;
      const indexes = await (collection as any).listSearchIndexes().toArray();
      const indexExists = indexes.some(
        (idx: any) => idx.name === this.CHUNK_SEARCH_INDEX,
      );

      if (!indexExists) {
        this.logger.log(
          `Creating MongoDB Atlas Search Index "${this.CHUNK_SEARCH_INDEX}" for BM25...`,
        );
        await (collection as any).createSearchIndex({
          name: this.CHUNK_SEARCH_INDEX,
          definition: {
            mappings: {
              dynamic: false,
              fields: {
                text: {
                  type: 'string',
                  analyzer: 'lucene.standard',
                },
                chatId: {
                  type: 'token',
                },
              },
            },
          },
        });
      }
    } catch (error: any) {
      this.logger.warn(
        `Could not automate Atlas Search Index creation: ${error.message}`,
      );
    }
  }

  async createSession(userId: string): Promise<ChatSessionDocument> {
    this.logger.log(`[Chat] Creating new session for user ${userId}`);
    const session = await new this.chatSessionModel({
      userId: toObjectId(userId),
    }).save();
    this.logger.debug(
      `[Chat] Created session ${session._id} for user ${userId}`,
    );
    return session;
  }

  async getSessions(userId: string): Promise<ChatSession[]> {
    this.logger.debug(`[Chat] Retrieving sessions for user ${userId}`);
    const sessions = await this.chatSessionModel
      .find({ userId: toObjectId(userId) })
      .sort({ createdAt: -1 })
      .exec();
    this.logger.debug(
      `[Chat] Retrieved ${sessions.length} sessions for user ${userId}`,
    );
    return sessions;
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
    this.logger.debug(
      `[Chat ${chatId}] Prepared ${contextChunks.length} context chunks for prompt generation`,
    );

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
    this.logger.debug(
      `[Chat ${chatObjectId}] Saving ${role} message (${
        content.length
      } chars, confidence=${confidenceScore ?? 'N/A'})`,
    );
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
      `[Chat ${chatId}] Step 3: Running hybrid search for ${rewrittenQueries.length} rewritten queries`,
    );
    const retrievalStartTime = Date.now();

    // 1. Parallel Vector Search (Pinecone)
    const vectorSearchResults = await Promise.all(
      rewrittenQueries.map(async (rewrittenQuery) => {
        try {
          const embedding =
            await this.aiService.generateEmbedding(rewrittenQuery);
          const result = await this.vectorService.query(embedding, 15, {
            chatId,
          });
          this.logger.debug(
            `[Chat ${chatId}] Vector search returned ${result.length} matches for rewritten query: "${rewrittenQuery}"`,
          );
          return result;
        } catch (error: any) {
          this.logger.warn(
            `[Chat ${chatId}] Vector search failed for query "${rewrittenQuery}": ${error.message}`,
          );
          return [];
        }
      }),
    );

    // 2. Parallel Keyword Search (MongoDB)
    const keywordSearchResults = await Promise.all(
      rewrittenQueries.map(async (rewrittenQuery) => {
        try {
          const result = await this.keywordSearch(chatId, rewrittenQuery, 15);
          this.logger.debug(
            `[Chat ${chatId}] Keyword search returned ${result.length} matches for rewritten query: "${rewrittenQuery}"`,
          );
          return result;
        } catch (error: any) {
          this.logger.warn(
            `[Chat ${chatId}] Keyword search failed for query "${rewrittenQuery}": ${error.message}`,
          );
          return [];
        }
      }),
    );

    const retrievalTime = Date.now() - retrievalStartTime;
    this.logger.debug(
      `[Chat ${chatId}] Hybrid retrieval completed in ${retrievalTime}ms`,
    );

    // 3. Combine results using Reciprocal Rank Fusion (RRF)
    this.logger.debug(
      `[Chat ${chatId}] Step 4: Applying Reciprocal Rank Fusion`,
    );
    const fusedMatches = this.applyRRF(
      vectorSearchResults.flat(),
      keywordSearchResults.flat(),
    );

    this.logger.debug(
      `[Chat ${chatId}] Step 4.5: Re-ranking ${fusedMatches.length} fused matches with Cohere`,
    );
    return this.aiService.rerankChunks(question, fusedMatches);
  }

  private async keywordSearch(
    chatId: string,
    query: string,
    topK: number,
  ): Promise<any[]> {
    if (this.isAtlas) {
      try {
        const results = await this.chunkModel
          .aggregate([
            {
              $search: {
                index: this.CHUNK_SEARCH_INDEX,
                compound: {
                  must: [
                    {
                      text: {
                        query: query,
                        path: 'text',
                      },
                    },
                  ],
                  filter: [
                    {
                      equals: {
                        value: toObjectId(chatId),
                        path: 'chatId',
                      },
                    },
                  ],
                },
              },
            },
            {
              $limit: topK,
            },
            {
              $addFields: {
                score: { $meta: 'searchScore' },
              },
            },
          ])
          .exec();

        return results.map((res) => ({
          id: `atlas-${res._id}`,
          score: res.score,
          metadata: {
            text: res.text,
            source: res.source,
            chatId: res.chatId.toString(),
            chunkIndex: res.chunkIndex,
            ...res.metadata,
          },
        }));
      } catch (error: any) {
        this.logger.warn(
          `Atlas Search failed, falling back to $text: ${error.message}`,
        );
      }
    }

    // Fallback to standard $text search (TF-IDF)
    const results = await this.chunkModel
      .find(
        {
          chatId: toObjectId(chatId),
          $text: { $search: query },
        },
        {
          score: { $meta: 'textScore' },
        },
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(topK)
      .exec();

    return results.map((res) => ({
      id: `mongo-${res._id}`,
      score: (res as any)._doc.score,
      metadata: {
        text: res.text,
        source: res.source,
        chatId: res.chatId.toString(),
        chunkIndex: res.chunkIndex,
        ...res.metadata,
      },
    }));
  }

  /**
   * Reciprocal Rank Fusion (RRF) to combine results from multiple search methods.
   * RRF score = sum(1 / (k + rank))
   */
  private applyRRF(
    vectorMatches: any[],
    keywordMatches: any[],
    k: number = 60,
  ): any[] {
    const scoreMap = new Map<string, { match: any; score: number }>();

    const updateScore = (matches: any[]) => {
      matches.forEach((match, index) => {
        const id =
          match.id?.toString() ||
          match._id?.toString() ||
          match.metadata?.chunkId?.toString() ||
          `${match.metadata?.source || 'unknown'}-${match.metadata?.chunkIndex ?? index}`;
        const current = scoreMap.get(id) || { match, score: 0 };
        // RRF Formula: 1 / (k + rank)
        current.score += 1 / (k + index + 1);
        scoreMap.set(id, current);
      });
    };

    updateScore(vectorMatches);
    updateScore(keywordMatches);

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map((item) => ({
        ...item.match,
        rrfScore: item.score,
      }))
      .slice(0, 20); // Top 20 for re-ranking
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
    this.logger.debug(`[Chat ${chatId}] Fetching history for user ${userId}`);
    await this.ensureOwnership(chatId, userId);
    const messages = await this.messageModel
      .find({ chatId: toObjectId(chatId) })
      .sort({ createdAt: 1 })
      .exec();
    this.logger.debug(
      `[Chat ${chatId}] Retrieved ${messages.length} messages from history`,
    );
    return messages;
  }

  async deleteSession(
    chatId: string,
    userId: string,
  ): Promise<{ deleted: boolean }> {
    this.logger.log(`[Chat ${chatId}] Deleting session for user ${userId}`);
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
      this.chunkModel.deleteMany({ chatId: toObjectId(chatId) }).exec(),
      this.vectorService.deleteByChatId(chatId),
    ]);

    this.logger.log(`[Chat ${chatId}] Deleted session and all associated data`);
    return { deleted: true };
  }

  private async ensureOwnership(
    chatId: string,
    userId: string,
  ): Promise<ChatSessionDocument> {
    this.logger.debug(
      `[Chat ${chatId}] Verifying ownership for user ${userId}`,
    );
    const session = await this.chatSessionModel.findOne({
      _id: toObjectId(chatId),
      userId: toObjectId(userId),
    });

    if (!session) {
      this.logger.warn(
        `[Chat ${chatId}] Ownership verification failed for user ${userId}`,
      );
      throw new NotFoundException('Chat session not found');
    }
    this.logger.debug(`[Chat ${chatId}] Ownership verified for user ${userId}`);
    return session;
  }
}
