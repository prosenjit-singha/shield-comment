import { Module } from '@nestjs/common';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module.js';
import { TokenCipherModule } from '../crypto/token-cipher.module.js';
import { MetaGraphModule } from '../meta/meta-graph.module.js';
import { CommentClassifier } from './comment-classifier.js';
import { ModerationActionExecutor } from './moderation-action.executor.js';
import { ModerationPolicyController } from './moderation-policy.controller.js';
import { ModerationPolicyService } from './moderation-policy.service.js';
import { PostContextService } from './post-context.service.js';

/**
 * Comment moderation (Module 5). M5-T5: the pure `CommentClassifier` (LLM only, no DB/Graph).
 * M5-T8: `ModerationPolicyService` + `GET/PATCH …/moderation/policy`; the pure `decideAction`
 * lives in `moderation-decision.ts`. M5-T9: `ModerationActionExecutor` (hide / unhide / delete /
 * reply on Meta + the `moderation_actions` log; no HTTP route, D10). M5-T10: `PostContextService`
 * (D8 Page name / cached post caption). The queue worker joins later.
 */
@Module({
  imports: [AiGatewayModule, MetaGraphModule, TokenCipherModule],
  controllers: [ModerationPolicyController],
  providers: [
    CommentClassifier,
    ModerationPolicyService,
    ModerationActionExecutor,
    PostContextService,
  ],
  exports: [
    CommentClassifier,
    ModerationPolicyService,
    ModerationActionExecutor,
    PostContextService,
  ],
})
export class ModerationModule {}
