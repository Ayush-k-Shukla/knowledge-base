import { Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentService } from './document.service';

@Controller('document')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Post('upload/:chatId')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@Param('chatId') chatId: string, @UploadedFile() file: Express.Multer.File) {
    await this.documentService.processDocument(chatId, file);
    return { message: 'File indexed successfully' };
  }

  @Get(':chatId')
  async getDocuments(@Param('chatId') chatId: string) {
    return this.documentService.findAll(chatId);
  }
}
