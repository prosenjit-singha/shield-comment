import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import { addDays, dhakaMidnight } from '../admin/dashboard-range.js';
import { dhakaDayKey } from '../comments/comments.queries.js';
import type { Database } from '../db/database.js';
import {
  PLAYGROUND_DAILY_LIMIT_DEFAULT,
  platformSettings,
} from '../db/schema/index.js';
import { RedisService } from '../redis/redis.service.js';
import {
  type ClassificationFailure,
  CommentClassifier,
} from './comment-classifier.js';
import {
  PLAYGROUND_ERROR_CODES,
  type PlaygroundTestDto,
  type PlaygroundTestResponse,
  type PlaygroundUsageResponse,
} from './dto/playground.dto.js';
import {
  decideAction,
  type DecisionCurrent,
  decideRuleAction,
} from './moderation-decision.js';
import {
  ModerationPolicyService,
  workspacePlanFeatures,
} from './moderation-policy.service.js';
import {
  classificationUsageDelta,
  recordDailyAiUsage,
} from './moderation.queries.js';
import { matchStaticRules } from './static-rules.js';

/**
 * The daily limit (D9): admin platform setting `playgroundDailyLimit` (M6-T7b), 10 without a row,
 * 0 = playground off. One primary-key read per test; no cache, so an admin change applies at once.
 */
export async function playgroundDailyLimit(db: Database): Promise<number> {
  const [row] = await db
    .select({ limit: platformSettings.playgroundDailyLimit })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1));
  return row?.limit ?? PLAYGROUND_DAILY_LIMIT_DEFAULT;
}

/** Counter key per workspace per Dhaka day; kept ~2 days so it outlives the day it counts. */
export const playgroundCounterKey = (workspaceId: string, day: string) =>
  `playground:${workspaceId}:${day}`;
export const PLAYGROUND_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

/** Next Dhaka midnight after `day`: when the daily count starts again. */
const playgroundResetsAt = (day: string) =>
  dhakaMidnight(addDays(day, 1)).toISOString();

/** Daily test counter (DI token: e2e swaps in a memory store, Redis is stubbed there). */
export abstract class PlaygroundCounter {
  /** Adds one test; returns the count including it. */
  abstract hit(key: string): Promise<number>;
  /** Takes one back (a refused or failed test). */
  abstract undo(key: string): Promise<void>;
  /** Today's count, read only (0 when unset). */
  abstract peek(key: string): Promise<number>;
}

@Injectable()
export class RedisPlaygroundCounter extends PlaygroundCounter {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async hit(key: string): Promise<number> {
    const client = await this.connected();
    const replies = await client
      .multi()
      .incr(key)
      .expire(key, PLAYGROUND_COUNTER_TTL_SECONDS)
      .exec();
    const [error, count] = replies?.[0] ?? [new Error('Redis MULTI aborted')];
    if (error) throw error;
    return Number(count);
  }

  async undo(key: string): Promise<void> {
    await (await this.connected()).decr(key);
  }

  async peek(key: string): Promise<number> {
    return Number((await (await this.connected()).get(key)) ?? 0);
  }

  private async connected() {
    const { client } = this.redis;
    if (client.status === 'wait') await client.connect();
    return client;
  }
}

/** The comment as the worker sees a new one: visible, never touched. */
const NEW_COMMENT: DecisionCurrent = {
  status: 'VISIBLE',
  overriddenAt: null,
  deletedAt: null,
  hiddenByAi: false,
  autoReplied: false,
};

@Injectable()
export class PlaygroundService {
  private readonly logger = new Logger('Playground');

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly policies: ModerationPolicyService,
    private readonly classifier: CommentClassifier,
    private readonly counter: PlaygroundCounter,
  ) {}

  /** Today's usage (M6-T11 `GET …/playground/usage`): reads the counter, never counts. */
  async usage(
    workspaceId: string,
    now = new Date(),
  ): Promise<PlaygroundUsageResponse> {
    const limit = await playgroundDailyLimit(this.db);
    const day = dhakaDayKey(now);
    const used = Math.max(
      0,
      await this.counter.peek(playgroundCounterKey(workspaceId, day)),
    );
    return {
      limit,
      used,
      testsLeft: Math.max(0, limit - used),
      resetsAt: playgroundResetsAt(day),
    };
  }

  /** Every test counts (rule-only too); a refused or failed one is given back. */
  async test(
    workspaceId: string,
    dto: PlaygroundTestDto,
    now = new Date(),
  ): Promise<PlaygroundTestResponse> {
    const limit = await playgroundDailyLimit(this.db);
    const day = dhakaDayKey(now);
    const key = playgroundCounterKey(workspaceId, day);
    const used = await this.counter.hit(key);
    const giveBack = () => this.counter.undo(key).catch(() => undefined);
    if (used > limit) {
      await giveBack();
      throw new HttpException(
        {
          message: limit
            ? `You have used today's ${limit} playground tests. Try again tomorrow.`
            : 'The playground is turned off right now.',
          error: 'Too Many Requests',
          code: PLAYGROUND_ERROR_CODES.limitReached,
          details: {
            limit,
            resetsAt: playgroundResetsAt(day),
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      return {
        ...(await this.run(workspaceId, dto, now)),
        testsLeft: limit - used,
      };
    } catch (error) {
      await giveBack();
      throw error;
    }
  }

  private async run(
    workspaceId: string,
    { text, platform = 'FACEBOOK' }: PlaygroundTestDto,
    now: Date,
  ): Promise<Omit<PlaygroundTestResponse, 'testsLeft'>> {
    const started = performance.now();
    const latency = () => Math.round(performance.now() - started);
    const policy = await this.policies.policy(workspaceId);

    const match = matchStaticRules(text, policy.rules);
    if (match) {
      return {
        ruleMatch: match,
        classification: null,
        decision: decideRuleAction(policy, match.kind, NEW_COMMENT),
        latencyMs: latency(),
      };
    }

    const result = await this.classifier.classify({
      text,
      platform,
      isReply: false,
      contextLevel: 'comment_only',
    });
    const usage = classificationUsageDelta(result, dhakaDayKey(now));
    // Like the worker: never fails the test, the AI call already happened.
    if (usage) {
      try {
        await recordDailyAiUsage(this.db, usage);
      } catch (error) {
        this.logger.warn(
          `AI usage not recorded (${error instanceof Error ? error.name : 'unknown error'})`,
        );
      }
    }
    if (!result.ok) throw aiFailure(result);

    const { category, confidence, reasoning, language } = result;
    return {
      ruleMatch: null,
      classification: { category, confidence, reasoning, language },
      decision: decideAction(
        policy,
        result,
        await workspacePlanFeatures(this.db, workspaceId, now),
        NEW_COMMENT,
      ),
      latencyMs: latency(),
    };
  }
}

function aiFailure(failure: ClassificationFailure): HttpException {
  if (failure.kind === 'not_configured') {
    return new ServiceUnavailableException({
      message: 'AI moderation is not available right now.',
      error: 'Service Unavailable',
      code: PLAYGROUND_ERROR_CODES.aiNotConfigured,
    });
  }
  return new BadGatewayException({
    message: 'The AI could not check this comment. Please try again.',
    error: 'Bad Gateway',
    code: PLAYGROUND_ERROR_CODES.aiFailed,
    details: { errorKind: failure.kind, retryable: failure.retryable },
  });
}
