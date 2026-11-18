import { Module } from '@nestjs/common';
import { CommentIngestProcessor } from './comment-ingest.processor.js';
import { CommentIngestService } from './comment-ingest.service.js';

/**
 * Comments (Module 4). M4-T5: the `comment-ingest` worker (`CommentIngestProcessor`, a BullMQ
 * `@Processor` in the API process, D3) + `CommentIngestService` (one tx per webhook change).
 * Queues come from the global `QueueModule`.
 */
@Module({
  providers: [CommentIngestService, CommentIngestProcessor],
  exports: [CommentIngestService],
})
export class CommentsModule {}
