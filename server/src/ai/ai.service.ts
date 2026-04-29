import { GoogleGenerativeAI } from '@google/generative-ai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CohereClientV2 } from 'cohere-ai';

export interface QueryRewrite {
  originalQuery: string;
  rewrittenQueries: string[];
}

export interface Citation {
  sourceId: string;
  chunkId: string;
  text: string;
  relevantSentences: string[];
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
    contextChunks: Array<{ id: string; sourceId: string; text: string }>,
  ): Promise<AnswerWithCitations> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
    });

    // Create context with chunk IDs for citation
    const contextWithIds = contextChunks
      .map((chunk, index) => `[${chunk.sourceId}:${chunk.id}]\n${chunk.text}`)
      .join('\n\n---\n\n');

    const prompt = `
      You are a helpful assistant that answers questions based ONLY on the provided context.
      You must follow these rules strictly:

      1. Answer ONLY using information from the provided context chunks.
      2. If the context doesn't contain enough information to answer the question, say "I don't have enough information in the provided context to answer this question."
      3. Use inline citations in the format [source_id:chunk_id] immediately after each factual statement.
      4. Do not hallucinate or add information not present in the context.
      5. Be concise but comprehensive.
      6. If citing multiple sources for the same point, list them as [source1:chunk1][source2:chunk2].

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
    contextChunks: Array<{ id: string; sourceId: string; text: string }>,
  ): Citation[] {
    const citationRegex = /\[([^\]]+):([^\]]+)\]/g;
    const citations: Citation[] = [];
    const processedCitations = new Set<string>();

    let match;
    while ((match = citationRegex.exec(answer)) !== null) {
      const [fullMatch, sourceId, chunkId] = match;
      const citationKey = `${sourceId}:${chunkId}`;

      if (processedCitations.has(citationKey)) continue;
      processedCitations.add(citationKey);

      const chunk = contextChunks.find(
        (c) => c.sourceId === sourceId && c.id === chunkId,
      );
      if (chunk) {
        // Extract 1-2 relevant sentences from the chunk
        const relevantSentences = this.extractRelevantSentences(
          chunk.text,
          answer,
        );
        citations.push({
          sourceId,
          chunkId,
          text: chunk.text,
          relevantSentences,
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
}
