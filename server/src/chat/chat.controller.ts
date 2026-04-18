import { Controller, Post, Get, Body } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('ask')
  async askQuestion(@Body('question') question: string) {
    const answer = await this.chatService.askQuestion(question);
    return { answer };
  }

  @Get('history')
  async getHistory() {
    return this.chatService.getHistory();
  }
}
