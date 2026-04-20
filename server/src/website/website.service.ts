import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as cheerio from 'cheerio';
import { Model, Types } from 'mongoose';
import { AiService } from '../ai/ai.service';
import {
  ChatSession,
  ChatSessionDocument,
} from '../chat/schemas/chat-session.schema';
import { VectorService } from '../vector/vector.service';
import { WebsiteDocument, WebsiteItem } from './schemas/website.schema';

@Injectable()
export class WebsiteService {
  private readonly logger = new Logger(WebsiteService.name);

  constructor(
    private aiService: AiService,
    private vectorService: VectorService,
    @InjectModel(WebsiteItem.name) private websiteModel: Model<WebsiteDocument>,
    @InjectModel(ChatSession.name)
    private chatSessionModel: Model<ChatSessionDocument>,
  ) {}

  /**
   * Main entry point: crawl a URL up to `depth` levels deep (same origin only),
   * chunk + embed all extracted text and upsert into Pinecone.
   */
  async indexWebsite(
    chatId: string,
    startUrl: string,
    depth: number = 1,
    maxPages: number = 5,
    userId?: string,
  ): Promise<{ pageCount: number; title: string }> {
    if (userId) {
      await this.ensureOwnership(chatId, userId);
    }

    const origin = new URL(startUrl).origin;
    const visited = new Set<string>();
    const queue: Array<{ url: string; level: number }> = [
      { url: startUrl, level: 0 },
    ];

    let pageCount = 0;
    let siteTitle = '';

    while (queue.length > 0) {
      // Stop once we've hit the page cap
      if (pageCount >= maxPages) {
        this.logger.log(
          `Reached maxPages limit (${maxPages}). Stopping crawl.`,
        );
        break;
      }

      const { url, level } = queue.shift()!;

      if (visited.has(url)) continue;
      visited.add(url);

      try {
        const { text, links, title } = await this.fetchPage(url);

        if (level === 0 && title) siteTitle = title;

        // Chunk & embed
        const chunks = this.chunkText(text, 1000, 200);
        const vectors: any[] = [];

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (!chunk.trim()) continue;

          const embedding = await this.aiService.generateEmbedding(chunk);
          vectors.push({
            id: `${chatId}-${encodeURIComponent(url)}-${i}`,
            values: embedding,
            metadata: {
              text: chunk,
              source: startUrl,
              pageUrl: url,
              chunkIndex: i,
              type: 'website',
              chatId,
            },
          });

          // Batch upsert every 50 vectors to avoid payload limits
          if (vectors.length >= 50) {
            await this.vectorService.upsert([...vectors]);
            vectors.length = 0;
          }
        }

        if (vectors.length > 0) {
          await this.vectorService.upsert(vectors);
        }

        pageCount++;
        this.logger.log(`Indexed page ${pageCount}: ${url}`);

        // Enqueue same-origin links if we haven't hit the depth limit
        if (level < depth) {
          for (const link of links) {
            if (
              !visited.has(link) &&
              link.startsWith(origin) &&
              this.isContentUrl(link)
            ) {
              queue.push({ url: link, level: level + 1 });
            }
          }
        }
      } catch (err) {
        this.logger.warn(`Failed to fetch ${url}: ${err.message}`);
      }
    }

    // Persist to MongoDB
    await this.websiteModel.findOneAndUpdate(
      { url: startUrl, chatId: new Types.ObjectId(chatId) },
      {
        url: startUrl,
        chatId: new Types.ObjectId(chatId),
        title: siteTitle || startUrl,
        pageCount,
        indexedAt: new Date(),
      },
      { upsert: true, new: true },
    );

    return { pageCount, title: siteTitle || startUrl };
  }

  async findAll(chatId: string, userId: string): Promise<WebsiteItem[]> {
    await this.ensureOwnership(chatId, userId);
    return this.websiteModel
      .find({ chatId: new Types.ObjectId(chatId) })
      .sort({ indexedAt: -1 })
      .exec();
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchPage(
    url: string,
  ): Promise<{ text: string; links: string[]; title: string }> {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; NexusRAGBot/1.0; +http://localhost)',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      return { text: '', links: [], title: '' };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove non-content elements
    $(
      'script, style, noscript, nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"]',
    ).remove();

    const title = $('title').first().text().trim();

    // Extract visible text
    const text = $('body').text().replace(/\s+/g, ' ').trim();

    // Extract same-page absolute links
    const base = new URL(url);
    const links: string[] = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      try {
        const resolved = new URL(href, base).href.split('#')[0]; // strip fragments
        if (resolved.startsWith('http')) {
          links.push(resolved);
        }
      } catch {
        // ignore malformed hrefs
      }
    });

    return { text, links: [...new Set(links)], title };
  }

  /**
   * Returns false for URLs that are unlikely to contain useful content:
   * edit pages, special pages, file/image pages, talk pages, user pages, etc.
   */
  private isContentUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const search = parsed.search;

      // Skip URLs with non-content query params (e.g. ?action=edit)
      if (search && /action=(edit|history|raw|submit|preview)/.test(search))
        return false;

      // Skip MediaWiki/Wikipedia special namespaces
      const skipPatterns = [
        /^\/wiki\/(Special|Talk|User|File|Image|Help|Template|Category_talk|Wikipedia|Wikipedia_talk|Portal):/i,
        /^\/w\/index\.php/,
      ];

      return !skipPatterns.some((re) => re.test(path));
    } catch {
      return false;
    }
  }

  private chunkText(text: string, size: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + size, text.length);
      chunks.push(text.substring(start, end));
      start += size - overlap;
    }
    return chunks;
  }
}
