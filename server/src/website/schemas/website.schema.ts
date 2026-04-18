import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WebsiteDocument = WebsiteItem & Document;

@Schema()
export class WebsiteItem {
  @Prop({ type: Types.ObjectId, ref: 'ChatSession', required: true })
  chatId: Types.ObjectId;

  @Prop({ required: true })
  url: string;

  @Prop({ default: '' })
  title: string;

  @Prop({ default: 0 })
  pageCount: number;

  @Prop({ default: Date.now })
  indexedAt: Date;
}

export const WebsiteSchema = SchemaFactory.createForClass(WebsiteItem);
