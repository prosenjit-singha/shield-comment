import { Module } from '@nestjs/common';
import { ModerationModule } from '../moderation/moderation.module.js';
import { CommentsFeedController } from './comments-feed.controller.js';
import { CommentIngestProcessor } from './comment-ingest.processor.js';
import { CommentIngestService } from './comment-ingest.service.js';
import { RawPayloadPurgeService } from './raw-payload-purge.js';

/**
 * Comments (Module 4). M4-T5: the `comment-ingest` worker (`CommentIngestProcessor`, a BullMQ
 * `@Processor` in the API process, D3) + `CommentIngestService` (one tx per webhook change).
 * Queues come from the global `QueueModule`. M4-T7: `RawPayloadPurgeService` (D4 30-day
 * `raw_payload` purge), run by the `meta-token-check` worker (`MetaCallbacksModule`).
 * M6-T3/T4: the workspace comments feed + manual override (`ModerationActionExecutor`).
 */
@Module({
  imports: [ModerationModule],
  controllers: [CommentsFeedController],
  providers: [
    CommentIngestService,
    CommentIngestProcessor,
    RawPayloadPurgeService,
  ],
  exports: [CommentIngestService, RawPayloadPurgeService],
})
export class CommentsModule {}
