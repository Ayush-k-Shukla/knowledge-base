import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DocumentDocument = DocumentItem & Document;

@Schema()
export class DocumentItem {
  @Prop({ type: Types.ObjectId, ref: 'ChatSession', required: true })
  chatId: Types.ObjectId;

  @Prop({ required: true })
  filename: string;

  @Prop({ default: Date.now })
  uploadedAt: Date;
}

export const DocumentSchema = SchemaFactory.createForClass(DocumentItem);
