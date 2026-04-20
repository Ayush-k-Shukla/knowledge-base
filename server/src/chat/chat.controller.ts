import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';

@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('session')
  async createSession(@Request() req: any) {
    return this.chatService.createSession(req.user.userId);
  }

  @Get('sessions')
  async getSessions(@Request() req: any) {
    return this.chatService.getSessions(req.user.userId);
  }

  @Post('ask/:chatId')
  async askQuestion(
    @Param('chatId') chatId: string,
    @Body('question') question: string,
    @Request() req: any,
  ) {
    const answer = await this.chatService.askQuestion(
      chatId,
      question,
      req.user.userId,
    );
    return { answer };
  }

  @Get('history/:chatId')
  async getHistory(@Param('chatId') chatId: string, @Request() req: any) {
    return this.chatService.getHistory(chatId, req.user.userId);
  }

  @Delete(':chatId')
  async deleteSession(@Param('chatId') chatId: string, @Request() req: any) {
    return this.chatService.deleteSession(chatId, req.user.userId);
  }
}
