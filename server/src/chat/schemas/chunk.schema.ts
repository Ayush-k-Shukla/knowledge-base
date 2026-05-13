import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ChunkDocument = Chunk & Document;

@Schema()
export class Chunk {
  @Prop({ type: Types.ObjectId, ref: 'ChatSession', required: true })
  chatId: Types.ObjectId;

  @Prop({ required: true })
  text: string;

  @Prop({ required: true })
  source: string; // Filename or URL

  @Prop({ required: true })
  chunkIndex: number;

  @Prop({ type: Object })
  metadata: Record<string, any>;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const ChunkSchema = SchemaFactory.createForClass(Chunk);

// Add a text index for keyword search
ChunkSchema.index({ text: 'text' });
