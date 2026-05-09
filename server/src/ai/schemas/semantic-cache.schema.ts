import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SemanticCacheDocument = SemanticCache & Document;

@Schema({ timestamps: true })
export class SemanticCache {
  @Prop({ required: true, enum: ['response', 'embedding'], index: true })
  type: string;

  @Prop({ type: Types.ObjectId, ref: 'ChatSession', index: true })
  chatId?: Types.ObjectId;

  @Prop({ required: true, index: true })
  input: string; // The query or text

  @Prop({ type: [Number], required: true })
  embedding: number[]; // The embedding of the input text

  @Prop({ type: Object, required: true })
  output: any; // The answer object

  @Prop()
  confidenceScore?: number;

  @Prop()
  confidenceReasoning?: string;

  @Prop({ type: Date, default: Date.now, index: { expires: '7d' } })
  createdAt: Date;
}

export const SemanticCacheSchema = SchemaFactory.createForClass(SemanticCache);

// Composite index for efficient lookups
SemanticCacheSchema.index({ type: 1, chatId: 1 });
SemanticCacheSchema.index({ type: 1, input: 1 });
