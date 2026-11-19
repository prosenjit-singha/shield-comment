import { Module } from '@nestjs/common';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module.js';
import { TokenCipherModule } from '../crypto/token-cipher.module.js';
import { MetaGraphModule } from '../meta/meta-graph.module.js';
import { CommentClassifier } from './comment-classifier.js';
import { ModerationActionExecutor } from './moderation-action.executor.js';
import { ModerationPolicyController } from './moderation-policy.controller.js';
import { ModerationPolicyService } from './moderation-policy.service.js';

/**
 * Comment moderation (Module 5). M5-T5: the pure `CommentClassifier` (LLM only, no DB/Graph).
 * M5-T8: `ModerationPolicyService` + `GET/PATCH …/moderation/policy`; the pure `decideAction`
 * lives in `moderation-decision.ts`. M5-T9: `ModerationActionExecutor` (hide / unhide / delete /
 * reply on Meta + the `moderation_actions` log; no HTTP route, D10). The queue worker joins later.
 */
@Module({
  imports: [AiGatewayModule, MetaGraphModule, TokenCipherModule],
  controllers: [ModerationPolicyController],
  providers: [
    CommentClassifier,
    ModerationPolicyService,
    ModerationActionExecutor,
  ],
  exports: [
    CommentClassifier,
    ModerationPolicyService,
    ModerationActionExecutor,
  ],
})
export class ModerationModule {}
