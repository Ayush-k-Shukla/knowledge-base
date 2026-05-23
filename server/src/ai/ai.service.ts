import { GoogleGenerativeAI } from '@google/generative-ai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cheerio from 'cheerio';
import { CohereClientV2 } from 'cohere-ai';
import { SemanticCacheService } from './semantic-cache.service';

export interface QueryRewrite {
  originalQuery: string;
  rewrittenQueries: string[];
}

export interface Citation {
  sourceId: string;
  chunkId: string;
  text: string;
  title?: string;
  relevantSentences: string[];
  originalMatch: string;
}

export interface AnswerWithCitations {
  answer: string;
  citations: Citation[];
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private genAI: GoogleGenerativeAI;
  private cohere?: CohereClientV2;
  private embeddingCache = new Map<
    string,
    { embedding: number[]; timestamp: number }
  >();
  private readonly CACHE_TTL = 1000 * 60 * 30; // 30 minutes
  private readonly MAX_CACHE_SIZE = 200; // Limit cache size to prevent memory bloat
  private webSearchCache = new Map<
    string,
    { results: Array<{ title: string; snippet: string }>; timestamp: number }
  >();
  private readonly WEB_CACHE_TTL = 1000 * 60 * 5; // 5 minutes for web search
  private readonly MAX_WEB_CACHE_SIZE = 100;

  constructor(
    private configService: ConfigService,
    private semanticCache: SemanticCacheService,
  ) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY')!;
    this.genAI = new GoogleGenerativeAI(apiKey);

    const cohereApiKey = this.configService.get<string>('COHERE_API_KEY');
    if (cohereApiKey) {
      this.cohere = new CohereClientV2({ token: cohereApiKey });
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // 1. Check in-memory cache first (exact match)
    const cached = this.embeddingCache.get(text);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      this.logger.debug(
        `[Local Embedding Cache] MEMORY HIT for text (${text.substring(0, 50)}...)`,
      );
      return cached.embedding;
    }

    // 2. Check persistent cache (exact match by input text)
    // We do this BEFORE calling the embedding model
    try {
      const persistent = await (this.semanticCache as any).cacheModel
        .findOne({ type: 'embedding', input: text })
        .exec();
      if (persistent) {
        this.logger.debug(
          `[Mongo Embedding Cache] PERSISTENT HIT for text (${text.substring(0, 50)}...)`,
        );
        // Also update memory cache
        this.embeddingCache.set(text, {
          embedding: persistent.embedding,
          timestamp: Date.now(),
        });
        return persistent.embedding;
      }
    } catch (e: any) {
      this.logger.warn(
        `Failed to check persistent embedding cache: ${e.message}`,
      );
    }

    // 3. Generate new embedding
    this.logger.debug(
      `[Both (MONGO + LOCAL) Embedding Cache] MISS for text (${text.substring(0, 50)}...) - generating new embedding`,
    );
    const startTime = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-embedding-001',
    });
    const result = await model.embedContent(text);
    const embedding = result.embedding.values;

    const generationTime = Date.now() - startTime;
    this.logger.debug(`Generated embedding in ${generationTime}ms`);

    // 4. Check for semantic match (if we have a close enough match, we could use that instead,
    // but usually with embeddings we want the exact one.
    // However, this is done in order for not storing 2 very similar embeddings)
    const similarEmbedding = await this.semanticCache.findSimilarEmbedding(
      text,
      embedding,
    );
    const finalEmbedding = similarEmbedding || embedding;

    if (similarEmbedding) {
      this.logger.debug(
        `[MONGO Embedding Cache] SEMANTIC HIT! Reusing similar embedding.`,
      );
    }

    // 5. Cache the result in memory and persistently
    this.embeddingCache.set(text, {
      embedding: finalEmbedding,
      timestamp: Date.now(),
    });

    await this.semanticCache.save({
      type: 'embedding',
      input: text,
      embedding: finalEmbedding,
    });
    this.logger.debug(
      `[AI] Saved embedding for text (${text.substring(0, 50)}...)`,
    );

    // Clean up memory cache
    if (this.embeddingCache.size > this.MAX_CACHE_SIZE) {
      this.cleanEmbeddingCache();
    }

    return finalEmbedding;
  }

  private cleanEmbeddingCache(): void {
    const entries = Array.from(this.embeddingCache.entries());

    // Sort by timestamp (oldest first) and remove oldest entries
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    // Remove oldest 20% of entries or until we're at 80% capacity
    const toRemove = Math.max(20, Math.floor(entries.length * 0.2));
    for (
      let i = 0;
      i < toRemove && this.embeddingCache.size > this.MAX_CACHE_SIZE * 0.8;
      i++
    ) {
      this.embeddingCache.delete(entries[i][0]);
    }
  }

  async rewriteQuery(query: string): Promise<QueryRewrite> {
    this.logger.debug(`[AI] Rewriting query: "${query}"`);
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
    });
    const prompt = `
      Rewrite the following user query into 3 different optimized search queries that would improve retrieval from a vector database.
      Each rewritten query should:
      - Be more specific and detailed
      - Use different phrasing to capture various aspects
      - Focus on key concepts and entities
      - Be suitable for semantic search

      Original query: "${query}"

      Return only a JSON array of 3 strings, no other text.
      Example: ["query1", "query2", "query3"]
    `;

    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();

    try {
      const parsedQueries = JSON.parse(response);
      if (!Array.isArray(parsedQueries) || parsedQueries.length !== 3) {
        throw new Error('Invalid response format');
      }
      const rewrittenQueries = parsedQueries.map((q) => q.toString());
      this.logger.debug(
        `[AI] Query rewrite produced ${rewrittenQueries.length} variations`,
      );
      return {
        originalQuery: query,
        rewrittenQueries,
      };
    } catch (error: any) {
      this.logger.warn(
        `[AI] Query rewriting failed, using fallback variations: ${error.message}`,
      );
      // Fallback to original query variations
      return {
        originalQuery: query,
        rewrittenQueries: [
          query,
          `What is ${query}?`,
          `Explain ${query} in detail`,
        ],
      };
    }
  }

  async rerankChunks(query: string, chunks: any[]): Promise<any[]> {
    this.logger.debug(
      `[AI] Reranking ${chunks?.length ?? 0} chunks for query: "${query}"`,
    );
    if (!this.cohere) {
      this.logger.warn('Cohere client not initialized. Skipping reranking.');
      return chunks;
    }

    if (!chunks || chunks.length === 0) {
      this.logger.debug(
        '[AI] No chunks to rerank. Returning empty result set.',
      );
      return [];
    }

    const documents = chunks.map((chunk) => chunk.metadata?.text || '');

    try {
      const response = await this.cohere.rerank({
        model: 'rerank-english-v3.0',
        query: query,
        documents: documents,
        topN: 10,
      });

      const rerankedChunks = [];
      for (const result of response.results) {
        const chunk = chunks[result.index];
        chunk.score = result.relevanceScore; // Set the new score from Cohere
        rerankedChunks.push(chunk);
      }
      this.logger.debug(
        `[AI] Cohere reranking completed. Returned ${rerankedChunks.length} chunks.`,
      );
      return rerankedChunks;
    } catch (error) {
      this.logger.error('Cohere rerank error:', error);
      return chunks; // fallback to original order
    }
  }

  async generateAnswerWithCitations(
    question: string,
    contextChunks: Array<{
      id: string;
      sourceId: string;
      text: string;
      title?: string;
    }>,
  ): Promise<AnswerWithCitations> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
    });

    // Create context with chunk IDs for citation
    const contextWithIds = contextChunks
      .map((chunk) => `[Source: ${chunk.sourceId}:${chunk.id}]\n${chunk.text}`)
      .join('\n\n---\n\n');

    this.logger.debug(
      `[AI] Generating answer with citations for question: "${question}" using ${contextChunks.length} context chunks`,
    );
    const prompt = `
      You are a helpful assistant that answers questions based ONLY on the provided context.
      You must follow these rules strictly:

      1. Answer ONLY using information from the provided context chunks.
      2. If the context doesn't contain enough information to answer the question, say "I don't have enough information in the provided context to answer this question."
      3. Use inline citations in the exact format [source_id:chunk_id] immediately after each factual statement.
      4. Do not use numeric index citations like [0] or [1]. Only [source_id:chunk_id] is allowed.
      5. Do not invent source_id or chunk_id values. If you cannot cite a valid provided chunk, omit the citation.
      6. Do not hallucinate or add information not present in the context.
      7. Be concise but comprehensive.
      8. If citing multiple sources for the same point, list them as [source1:chunk1][source2:chunk2].

      CONTEXT:
      ${contextWithIds}

      QUESTION: ${question}

      ANSWER:
    `;

    const result = await model.generateContent(prompt);
    const rawAnswer = result.response.text().trim();
    this.logger.debug(
      `[AI] Generated answer with ${rawAnswer.length} chars and ${contextChunks.length} context chunks`,
    );

    const { cleanedAnswer, citations } = this.validateAndCleanCitations(
      rawAnswer,
      contextChunks,
    );
    this.logger.debug(
      `[AI] Extracted ${citations.length} verified citation(s) from answer`,
    );

    return {
      answer: cleanedAnswer,
      citations,
    };
  }

  private validateAndCleanCitations(
    answer: string,
    contextChunks: Array<{
      id: string;
      sourceId: string;
      text: string;
      title?: string;
      metadata?: any;
    }>,
  ): { cleanedAnswer: string; citations: Citation[] } {
    const citationRegex = /\[([^:\]\s]+):([^\]\s]+)\]/g;
    const citations: Citation[] = [];
    const processedCitations = new Set<string>();
    const invalidCitations: Array<{ start: number; end: number }> = [];
    const validCitationKeys = new Set(
      contextChunks.map((chunk) => `${chunk.sourceId}:${chunk.id}`),
    );

    let match;
    while ((match = citationRegex.exec(answer)) !== null) {
      const fullMatch = match[0];
      const sourceIdFromMatch = match[1]?.trim();
      const chunkIdFromMatch = match[2]?.trim();
      const citationStart = match.index;
      const citationEnd = citationStart + fullMatch.length;

      if (!sourceIdFromMatch || !chunkIdFromMatch) {
        invalidCitations.push({ start: citationStart, end: citationEnd });
        continue;
      }

      const citationKey = `${sourceIdFromMatch}:${chunkIdFromMatch}`;
      if (!validCitationKeys.has(citationKey)) {
        invalidCitations.push({ start: citationStart, end: citationEnd });
        continue;
      }

      if (processedCitations.has(citationKey)) {
        continue;
      }

      processedCitations.add(citationKey);
      const chunk = contextChunks.find(
        (c) => `${c.sourceId}:${c.id}` === citationKey,
      );
      if (!chunk) {
        invalidCitations.push({ start: citationStart, end: citationEnd });
        continue;
      }

      const relevantSentences = this.extractRelevantSentences(
        chunk.text,
        answer,
      );
      citations.push({
        sourceId:
          chunk.metadata?.source ||
          chunk.metadata?.sourceId ||
          chunk.metadata?.documentId ||
          chunk.sourceId,
        chunkId: chunk.id,
        text: chunk.text,
        title: chunk.metadata?.title || chunk.metadata?.source || chunk.title,
        relevantSentences,
        originalMatch: fullMatch,
      });
    }

    let cleanedAnswer = answer;
    if (invalidCitations.length > 0) {
      this.logger.warn(
        `[AI] Removed ${invalidCitations.length} invalid or fabricated citation(s) from generated answer`,
      );
      invalidCitations.sort((a, b) => b.start - a.start);
      for (const invalid of invalidCitations) {
        cleanedAnswer =
          cleanedAnswer.slice(0, invalid.start) +
          cleanedAnswer.slice(invalid.end);
      }
      cleanedAnswer = cleanedAnswer.replace(/\s{2,}/g, ' ').trim();
    }

    return { cleanedAnswer, citations };
  }

  private extractRelevantSentences(
    chunkText: string,
    answer: string,
  ): string[] {
    // Split chunk into sentences
    const sentences = chunkText
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 0);

    // Simple relevance scoring based on word overlap with answer
    const answerWords = answer
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);

    const scoredSentences = sentences.map((sentence) => {
      const sentenceWords = sentence.toLowerCase().split(/\W+/);
      const overlap = answerWords.filter((word) =>
        sentenceWords.includes(word),
      ).length;
      return {
        sentence: sentence.trim(),
        score: overlap,
      };
    });

    // Return top 1-2 most relevant sentences
    return scoredSentences
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((s) => s.sentence);
  }

  async evaluateContext(
    question: string,
    contextChunks: any[],
  ): Promise<{
    action: 'ANSWER' | 'ASK_CLARIFICATION' | 'WEB_SEARCH';
    reasoning: string;
    message?: string;
  }> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      generationConfig: { responseMimeType: 'application/json' },
    });

    const contextWithIds = contextChunks
      .map((chunk, index) => `[Chunk ${index}]\n${chunk.text}`)
      .join('\n\n---\n\n');

    const prompt = `
      You are an Agentic Routing Engine for a question-answering bot.
      Your job is to evaluate if the provided context is sufficient to answer the user's question.

      Rules for Action:
      - "ANSWER": The context has enough information to provide a solid answer.
      - "ASK_CLARIFICATION": The question is ambiguous, unclear, or contradictory. You need the user to clarify. Provide the clarifying question in the "message" field.
      - "WEB_SEARCH": The question requires external knowledge, current events, or facts not present in the context. Provide the optimal search query in the "message" field.

      CONTEXT:
      ${contextWithIds}

      QUESTION: ${question}

      Output MUST be valid JSON matching this schema:
      {
        "action": "ANSWER" | "ASK_CLARIFICATION" | "WEB_SEARCH",
        "reasoning": "Explanation of why this action was chosen",
        "message": "Clarifying question (if ASK_CLARIFICATION) OR Search query (if WEB_SEARCH)"
      }
    `;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    try {
      const evaluation = JSON.parse(responseText);
      this.logger.debug(
        `[AI] Context evaluation action=${evaluation.action} reasoning=${evaluation.reasoning}`,
      );
      return evaluation;
    } catch (e: any) {
      this.logger.error('Failed to parse evaluation JSON', e);
      return { action: 'ANSWER', reasoning: 'Fallback due to parse error' };
    }
  }

  async performWebSearch(
    query: string,
  ): Promise<Array<{ title: string; snippet: string }>> {
    // Check cache first
    const cached = this.webSearchCache.get(query);
    if (cached && Date.now() - cached.timestamp < this.WEB_CACHE_TTL) {
      this.logger.debug(`[Web Search Cache] HIT for query: "${query}"`);
      return cached.results;
    }

    this.logger.debug(
      `[Web Search Cache] MISS for query: "${query}" - performing web search`,
    );
    const startTime = Date.now();

    try {
      const response = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          },
        },
      );

      const html = await response.text();
      const $ = cheerio.load(html);

      const results: Array<{ title: string; snippet: string }> = [];

      $('.result')
        .slice(0, 5)
        .each((i, el) => {
          const title = $(el).find('.result__title').text().trim();
          const snippet = $(el).find('.result__snippet').text().trim();
          if (title && snippet) {
            results.push({ title, snippet });
          }
        });

      const searchTime = Date.now() - startTime;
      this.logger.debug(
        `[Web Search Cache] Completed web search in ${searchTime}ms, found ${results.length} results`,
      );

      // Cache the results
      this.webSearchCache.set(query, { results, timestamp: Date.now() });

      // Clean up old cache entries
      if (this.webSearchCache.size > this.MAX_WEB_CACHE_SIZE) {
        const beforeSize = this.webSearchCache.size;
        this.cleanWebSearchCache();
        const afterSize = this.webSearchCache.size;
        this.logger.debug(
          `[Web Search Cache] Cleaned up ${beforeSize - afterSize} entries. Cache size: ${afterSize}/${this.MAX_WEB_CACHE_SIZE}`,
        );
      }

      return results;
    } catch (error: any) {
      const searchTime = Date.now() - startTime;
      this.logger.error(
        `[Web Search Cache] Web search failed after ${searchTime}ms: ${error.message}`,
      );
      return [];
    }
  }

  private cleanWebSearchCache(): void {
    const entries = Array.from(this.webSearchCache.entries());

    // Sort by timestamp (oldest first) and remove oldest entries
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    // Remove oldest 20% of entries or until we're at 80% capacity
    const toRemove = Math.max(10, Math.floor(entries.length * 0.2));
    for (
      let i = 0;
      i < toRemove && this.webSearchCache.size > this.MAX_WEB_CACHE_SIZE * 0.8;
      i++
    ) {
      this.webSearchCache.delete(entries[i][0]);
    }
  }

  async calculateConfidenceScore(
    question: string,
    answer: string,
    contextChunks: Array<{
      id: string;
      sourceId: string;
      text: string;
      title?: string;
    }>,
  ): Promise<{ score: number; reasoning: string }> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
    });

    const contextText = contextChunks
      .map(
        (c) =>
          `[${c.sourceId}:${c.id}] ${c.title ? c.title + '\n' : ''}${c.text}`,
      )
      .join('\n\n---\n\n');

    const prompt = `
      You are an expert AI auditor evaluating the grounding and factual accuracy of an AI-generated answer.
      You will be provided with:
      1. A user question
      2. The retrieved context chunks
      3. The AI's generated answer

      Your task is to evaluate how well the AI's answer is supported by the context.
      - Does the answer contain hallucinations (facts not present in the context)?
      - Does the answer directly address the question using only the provided context?

      Score the answer from 0 to 100, where:
      - 90-100: Perfectly grounded in the context.
      - 70-89: Mostly grounded, but might contain minor extrapolations or miss some nuances.
      - 40-69: Partially grounded, contains some unsupported claims.
      - 0-39: Poorly grounded, hallucinated, or completely contradicts the context.

      Return the evaluation as a JSON object with two fields:
      - "score": A number between 0 and 100.
      - "reasoning": A brief explanation of why this score was given (1-2 sentences).

      Question: ${question}

      Context:
      ${contextText}

      Generated Answer:
      ${answer}
    `;

    try {
      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const responseText = response.response.text();
      const scoreResult = JSON.parse(responseText);
      this.logger.debug(
        `[AI] Confidence score calculated: ${scoreResult.score} (${scoreResult.reasoning})`,
      );
      return scoreResult;
    } catch (e: any) {
      this.logger.error('Failed to calculate confidence score', e);
      return {
        score: 50,
        reasoning:
          'Failed to calculate confidence score due to an internal error.',
      };
    }
  }

  async generateChatTitle(
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
    });

    const conversationText = messages
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join('\n');

    const prompt = `
      Based on the following conversation, generate a concise, descriptive title (5-10 words) that captures the main topic or question.

      Conversation:
      ${conversationText}

      Title:
    `;

    this.logger.debug(
      `[AI] Generating chat title for ${messages.length} messages`,
    );
    try {
      const result = await model.generateContent(prompt);
      const title = result.response.text().trim();
      // Clean up the title, remove quotes if present
      const cleaned = title.replace(/^["']|["']$/g, '').substring(0, 50);
      this.logger.debug(`[AI] Generated chat title: "${cleaned}"`);
      return cleaned;
    } catch (error: any) {
      this.logger.error('Failed to generate chat title:', error);
      return 'Chat Session';
    }
  }
}
