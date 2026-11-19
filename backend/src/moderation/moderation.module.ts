import { Module } from '@nestjs/common';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module.js';
import { CommentClassifier } from './comment-classifier.js';

/**
 * Comment moderation (Module 5). M5-T5: the pure `CommentClassifier` (LLM only, no DB/Graph).
 * The policy, executor and queue worker join in later rows.
 */
@Module({
  imports: [AiGatewayModule],
  providers: [CommentClassifier],
  exports: [CommentClassifier],
})
export class ModerationModule {}
