import { GoogleGenerativeAI } from '@google/generative-ai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CohereClientV2 } from 'cohere-ai';
import * as cheerio from 'cheerio';


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
  private genAI: GoogleGenerativeAI;
  private cohere: CohereClientV2;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY')!;
    this.genAI = new GoogleGenerativeAI(apiKey);

    const cohereApiKey = this.configService.get<string>('COHERE_API_KEY');
    if (cohereApiKey) {
      this.cohere = new CohereClientV2({ token: cohereApiKey });
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-embedding-001',
    });
    const result = await model.embedContent(text);
    return result.embedding.values;
  }

  async rewriteQuery(query: string): Promise<QueryRewrite> {
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
      const rewrittenQueries = JSON.parse(response);
      if (!Array.isArray(rewrittenQueries) || rewrittenQueries.length !== 3) {
        throw new Error('Invalid response format');
      }
      return {
        originalQuery: query,
        rewrittenQueries: rewrittenQueries.map((q) => q.toString()),
      };
    } catch (error) {
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
    if (!this.cohere) {
      console.warn('Cohere client not initialized. Skipping reranking.');
      return chunks;
    }

    if (!chunks || chunks.length === 0) return [];

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
      return rerankedChunks;
    } catch (error) {
      console.error('Cohere rerank error:', error);
      return chunks; // fallback to original order
    }
  }

  async generateAnswerWithCitations(
    question: string,
    contextChunks: Array<{ id: string; sourceId: string; text: string; title?: string }>,
  ): Promise<AnswerWithCitations> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
    });

    // Create context with chunk IDs for citation
    const contextWithIds = contextChunks
      .map((chunk, index) => `[Index: ${index}] [Source: ${chunk.sourceId}:${chunk.id}]\n${chunk.text}`)
      .join('\n\n---\n\n');

    const prompt = `
      You are a helpful assistant that answers questions based ONLY on the provided context.
      You must follow these rules strictly:

      1. Answer ONLY using information from the provided context chunks.
      2. If the context doesn't contain enough information to answer the question, say "I don't have enough information in the provided context to answer this question."
      3. Use inline citations in the format [source_id:chunk_id] immediately after each factual statement.
      4. As a fallback, you may use [index] (e.g., [0], [1]) if the source_id:chunk_id is too long, but [source_id:chunk_id] is preferred.
      5. Do not hallucinate or add information not present in the context.
      6. Be concise but comprehensive.
      7. If citing multiple sources for the same point, list them as [source1:chunk1][source2:chunk2] or [0][1].

      CONTEXT:
      ${contextWithIds}

      QUESTION: ${question}

      ANSWER:
    `;

    const result = await model.generateContent(prompt);
    const answer = result.response.text().trim();

    // Extract citations from the answer
    const citations = this.extractCitationsFromAnswer(answer, contextChunks);

    return {
      answer,
      citations,
    };
  }

  private extractCitationsFromAnswer(
    answer: string,
    contextChunks: Array<{ id: string; sourceId: string; text: string; title?: string, metadata?: any }>,
  ): Citation[] {
    // Matches [sourceId:chunkId] or [index]
    const citationRegex = /\[(?:([^:\]\s]+):([^\]\s]+)|(\d+))\]/g;
    const citations: Citation[] = [];
    const processedCitations = new Set<string>();

    let match;
    while ((match = citationRegex.exec(answer)) !== null) {
      const fullMatch = match[0];
      const sourceIdFromMatch = match[1]?.trim();
      const chunkIdFromMatch = match[2]?.trim();
      const indexFromMatch = match[3];

      let chunk;
      let citationKey;

      if (indexFromMatch !== undefined) {
        // Numeric citation like [0]
        const index = parseInt(indexFromMatch, 10);
        chunk = contextChunks[index];
        citationKey = `index:${index}`;
      } else if (sourceIdFromMatch && chunkIdFromMatch) {
        // Complex citation like [source:id]
        chunk = contextChunks.find(
          (c) => c.sourceId === sourceIdFromMatch && c.id === chunkIdFromMatch,
        );
        citationKey = `${sourceIdFromMatch}:${chunkIdFromMatch}`;
      }

      if (chunk && citationKey && !processedCitations.has(citationKey)) {
        processedCitations.add(citationKey);
        
        // Extract 1-2 relevant sentences from the chunk
        const relevantSentences = this.extractRelevantSentences(
          chunk.text,
          answer,
        );

        citations.push({
          sourceId: chunk.metadata?.source || chunk.metadata?.sourceId || chunk.metadata?.documentId || chunk.sourceId,
          chunkId: chunk.id,
          text: chunk.text,
          title: chunk.metadata?.title || chunk.metadata?.source || chunk.title,
          relevantSentences,
          originalMatch: fullMatch,
        });
      }
    }

    return citations;
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

  // Keep the old method for backward compatibility
  async generateAnswer(prompt: string, context: string): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
    });
    const fullPrompt = `
      You are a helpful assistant. Use the following context to answer the user's question.
      If the context doesn't contain the answer, say you don't know based on the documents provided.

      CONTEXT:
      ${context}

      QUESTION:
      ${prompt}
    `;
    const result = await model.generateContent(fullPrompt);
    return result.response.text();
  }

  async evaluateContext(question: string, contextChunks: any[]): Promise<{ action: 'ANSWER' | 'ASK_CLARIFICATION' | 'WEB_SEARCH', reasoning: string, message?: string }> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      generationConfig: { responseMimeType: "application/json" }
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
      return JSON.parse(responseText);
    } catch (e) {
      console.error('Failed to parse evaluation JSON', e);
      return { action: 'ANSWER', reasoning: 'Fallback due to parse error' };
    }
  }

  async performWebSearch(query: string): Promise<Array<{title: string, snippet: string}>> {
    try {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      const html = await response.text();
      const $ = cheerio.load(html);
      
      const results: Array<{title: string, snippet: string}> = [];
      
      $('.result').slice(0, 5).each((i, el) => {
        const title = $(el).find('.result__title').text().trim();
        const snippet = $(el).find('.result__snippet').text().trim();
        if (title && snippet) {
          results.push({ title, snippet });
        }
      });
      
      return results;
    } catch (error) {
      console.error('Web search error:', error);
      return [];
    }
  }

  async calculateConfidenceScore(
    question: string,
    answer: string,
    contextChunks: Array<{ id: string; sourceId: string; text: string; title?: string }>,
  ): Promise<{ score: number; reasoning: string }> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
    });

    const contextText = contextChunks
      .map((c) => `[${c.sourceId}:${c.id}] ${c.title ? c.title + '\n' : ''}${c.text}`)
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
      return JSON.parse(responseText);
    } catch (e) {
      console.error('Failed to calculate confidence score', e);
      return { score: 50, reasoning: 'Failed to calculate confidence score due to an internal error.' };
    }
  }
}

