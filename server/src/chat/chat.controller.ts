import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('session')
  async createSession() {
    return this.chatService.createSession();
  }

  @Get('sessions')
  async getSessions() {
    return this.chatService.getSessions();
  }

  @Post('ask/:chatId')
  async askQuestion(@Param('chatId') chatId: string, @Body('question') question: string) {
    const answer = await this.chatService.askQuestion(chatId, question);
    return { answer };
  }

  @Get('history/:chatId')
  async getHistory(@Param('chatId') chatId: string) {
    return this.chatService.getHistory(chatId);
  }
}
