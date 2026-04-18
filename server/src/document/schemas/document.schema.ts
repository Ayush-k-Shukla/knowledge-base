import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DocumentDocument = DocumentItem & Document;

@Schema()
export class DocumentItem {
  @Prop({ required: true })
  filename: string;

  @Prop({ default: Date.now })
  uploadedAt: Date;
}

export const DocumentSchema = SchemaFactory.createForClass(DocumentItem);
