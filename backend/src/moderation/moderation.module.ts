import { Module } from '@nestjs/common';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module.js';
import { CommentClassifier } from './comment-classifier.js';
import { ModerationPolicyController } from './moderation-policy.controller.js';
import { ModerationPolicyService } from './moderation-policy.service.js';

/**
 * Comment moderation (Module 5). M5-T5: the pure `CommentClassifier` (LLM only, no DB/Graph).
 * M5-T8: `ModerationPolicyService` + `GET/PATCH …/moderation/policy`; the pure `decideAction`
 * lives in `moderation-decision.ts`. The executor and queue worker join in later rows.
 */
@Module({
  imports: [AiGatewayModule],
  controllers: [ModerationPolicyController],
  providers: [CommentClassifier, ModerationPolicyService],
  exports: [CommentClassifier, ModerationPolicyService],
})
export class ModerationModule {}
