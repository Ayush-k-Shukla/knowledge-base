import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { WebsiteService } from './website.service';

@Controller('website')
export class WebsiteController {
  constructor(private readonly websiteService: WebsiteService) {}

  @Post('index/:chatId')
  async indexWebsite(
    @Param('chatId') chatId: string,
    @Body() body: { url: string; depth?: number; maxPages?: number },
  ) {
    const { url, depth = 1, maxPages = 15 } = body;

    if (!url) {
      throw new BadRequestException('url is required');
    }

    try {
      new URL(url); // validate URL format
    } catch {
      throw new BadRequestException('Invalid URL format');
    }

    const { pageCount, title } = await this.websiteService.indexWebsite(chatId, url, depth, maxPages);
    return { message: 'Website indexed successfully', pageCount, title };
  }

  @Get(':chatId')
  async getWebsites(@Param('chatId') chatId: string) {
    return this.websiteService.findAll(chatId);
  }
}
