import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ChatSessionDocument = ChatSession & Document;

@Schema()
export class ChatSession {
  @Prop({ required: true, default: 'New Chat' })
  title: string;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const ChatSessionSchema = SchemaFactory.createForClass(ChatSession);
