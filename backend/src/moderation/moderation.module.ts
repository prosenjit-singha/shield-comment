import { Module } from '@nestjs/common';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module.js';
import { TokenCipherModule } from '../crypto/token-cipher.module.js';
import { MetaGraphModule } from '../meta/meta-graph.module.js';
import { CommentClassifier } from './comment-classifier.js';
import { CommentModerationProcessor } from './comment-moderation.processor.js';
import { CommentModerationService } from './comment-moderation.service.js';
import {
  ModerationJobSchedulers,
  ModerationSweeper,
} from './comment-moderation.sweeper.js';
import { ModerationActionExecutor } from './moderation-action.executor.js';
import { ModerationPolicyController } from './moderation-policy.controller.js';
import { ModerationPolicyService } from './moderation-policy.service.js';
import { PlaygroundController } from './playground.controller.js';
import {
  PlaygroundCounter,
  PlaygroundService,
  RedisPlaygroundCounter,
} from './playground.js';
import { PostContextService } from './post-context.service.js';
import { WalletModule } from '../wallet/wallet.module.js';

/**
 * Comment moderation (Module 5). M5-T5: the pure `CommentClassifier` (LLM only, no DB/Graph).
 * M5-T8: `ModerationPolicyService` + `GET/PATCH …/moderation/policy`; the pure `decideAction`
 * lives in `moderation-decision.ts`. M5-T9: `ModerationActionExecutor` (hide / unhide / delete /
 * reply on Meta + the `moderation_actions` log; no HTTP route, D10). M5-T10: `PostContextService`
 * (D8 Page name / cached post caption). M5-T12: the `comment-moderation` worker
 * (`CommentModerationProcessor` → `CommentModerationService`) + the D2 sweeper
 * (`ModerationSweeper`, scheduled by `ModerationJobSchedulers`). PW-T4: the worker counts each
 * comment once against the account wallet's `monthlyComments` meter (`WalletModule`). M6-T7: the
 * playground (`POST …/playground/test`, `PlaygroundService` + Redis daily counter).
 */
@Module({
  imports: [AiGatewayModule, MetaGraphModule, TokenCipherModule, WalletModule],
  controllers: [ModerationPolicyController, PlaygroundController],
  providers: [
    CommentClassifier,
    ModerationPolicyService,
    ModerationActionExecutor,
    PostContextService,
    CommentModerationService,
    CommentModerationProcessor,
    ModerationSweeper,
    ModerationJobSchedulers,
    PlaygroundService,
    { provide: PlaygroundCounter, useClass: RedisPlaygroundCounter },
  ],
  exports: [
    CommentClassifier,
    ModerationPolicyService,
    ModerationActionExecutor,
    PostContextService,
  ],
})
export class ModerationModule {}
