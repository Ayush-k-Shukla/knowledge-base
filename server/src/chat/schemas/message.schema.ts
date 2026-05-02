import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MessageDocument = Message & Document;

@Schema()
export class Message {
  @Prop({ type: Types.ObjectId, ref: 'ChatSession', required: true })
  chatId: Types.ObjectId;

  @Prop({ required: true })
  role: 'user' | 'bot';

  @Prop({ required: true })
  content: string;

  @Prop({ required: false })
  confidenceScore?: number;

  @Prop({ required: false })
  confidenceReasoning?: string;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);
