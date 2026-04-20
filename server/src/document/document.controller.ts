import {
  Controller,
  Get,
  Param,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DocumentService } from './document.service';

@UseGuards(JwtAuthGuard)
@Controller('document')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Post('upload/:chatId')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @Param('chatId') chatId: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    await this.documentService.processDocument(chatId, file, req.user.userId);
    return { message: 'File indexed successfully' };
  }

  @Get(':chatId')
  async getDocuments(@Param('chatId') chatId: string, @Request() req: any) {
    return this.documentService.findAll(chatId, req.user.userId);
  }
}
