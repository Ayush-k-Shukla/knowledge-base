import { GoogleGenerativeAI } from '@google/generative-ai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AiService {
  private genAI: GoogleGenerativeAI;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY')!;
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const model = this.genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
    const result = await model.embedContent(text);
    return result.embedding.values;
  }
  async generateAnswer(prompt: string, context: string): Promise<string> {
    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
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
