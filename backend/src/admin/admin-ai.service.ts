import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  sql,
} from 'drizzle-orm';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import {
  aiCreditTopupAuditLogs,
  aiCreditTopups,
  comments,
  dailyAiUsage,
  moderationActions,
  socialPages,
  users,
  workspaces,
} from '../db/schema/index.js';
import {
  configuredModelPrices,
  type ModelPriceTable,
} from '../moderation/ai-model-prices.js';
import {
  type AiDecisionTotalsRow,
  analysisCostUsd,
  analyzedSince,
  buildAiSpendSummary,
} from './ai-spend-summary.js';
import { dhakaDate } from './manual-activation.js';
import {
  AI_ANALYSES_LIMIT_MAX,
  type AiAnalysesResponse,
  type AiCreditTopup,
  type AiCreditTopupsResponse,
  type AiDecision,
  type AiSpendSummary,
  type CreateAiCreditTopupDto,
} from './dto/admin-ai.dto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TopupActor {
  adminId: string;
  adminName: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Admin AI analysis log, spend summary and credit top-ups (M5-T15d, D25/D26). Platform-wide data
 * across every workspace on purpose: these are super-admin routes (`SuperAdminGuard`), not tenant
 * routes. Comment text is returned to the super admin only and never logged; no Page tokens are
 * read.
 */
@Injectable()
export class AdminAiService {
  /** Overridable clock (tests). */
  now: () => Date = () => new Date();
  private readonly prices: ModelPriceTable;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.prices = configuredModelPrices(
      config.get('AI_MODEL_PRICES', { infer: true }),
    );
  }

  /**
   * The AI's Meta decision per comment: the latest AUTO hide / unhide / delete at or after the
   * classification (an edit re-classifies, so older actions belong to an older text).
   */
  private latestAutoAction() {
    return this.db
      .select({
        action: moderationActions.action,
        state: moderationActions.state,
      })
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.commentId, comments.id),
          eq(moderationActions.source, 'AUTO'),
          inArray(moderationActions.action, ['HIDE', 'UNHIDE', 'DELETE']),
          gte(moderationActions.createdAt, comments.classifiedAt),
        ),
      )
      .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
      .limit(1)
      .as('latest_action');
  }

  async analyses(limit = AI_ANALYSES_LIMIT_MAX): Promise<AiAnalysesResponse> {
    const action = this.latestAutoAction();
    const rows = await this.db
      .select({
        id: comments.id,
        classifiedAt: comments.classifiedAt,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        pageRowId: socialPages.id,
        pageId: socialPages.pageId,
        pageName: socialPages.pageName,
        platform: comments.platform,
        message: comments.message,
        category: comments.category,
        confidence: comments.confidence,
        action: action.action,
        actionState: action.state,
        status: comments.status,
        statusReason: comments.statusReason,
        provider: comments.aiProvider,
        model: comments.model,
        inputTokens: comments.aiInputTokens,
        outputTokens: comments.aiOutputTokens,
        latencyMs: comments.aiLatencyMs,
      })
      .from(comments)
      .innerJoin(workspaces, eq(workspaces.id, comments.workspaceId))
      .leftJoin(socialPages, eq(socialPages.id, comments.socialPageId))
      .leftJoinLateral(action, sql`true`)
      .where(isNotNull(comments.classifiedAt))
      .orderBy(desc(comments.classifiedAt), desc(comments.id))
      .limit(limit);

    return {
      items: rows.flatMap((r) => {
        // `comments_classification_complete`: these are all set when `classified_at` is.
        if (
          !r.classifiedAt ||
          !r.category ||
          r.confidence === null ||
          !r.provider ||
          !r.model
        ) {
          return [];
        }
        return [
          {
            id: r.id,
            classifiedAt: r.classifiedAt,
            workspace: { id: r.workspaceId, name: r.workspaceName },
            page:
              r.pageRowId && r.pageId && r.pageName
                ? { id: r.pageRowId, pageId: r.pageId, name: r.pageName }
                : null,
            platform: r.platform,
            message: r.message,
            category: r.category,
            confidence: r.confidence,
            decision: toDecision(r.action),
            actionState: r.actionState,
            status: r.status,
            statusReason: r.statusReason,
            provider: r.provider,
            model: r.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            latencyMs: r.latencyMs,
            estimatedCostUsd: analysisCostUsd(this.prices, {
              provider: r.provider,
              model: r.model,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
            }),
          },
        ];
      }),
    };
  }

  async summary(): Promise<AiSpendSummary> {
    const now = this.now();
    const since = analyzedSince(now);
    const action = this.latestAutoAction();
    const decision = sql<AiDecision>`case ${action.action} when 'HIDE' then 'HIDE' when 'DELETE' then 'DELETE' else 'NONE' end`;
    // ponytail: full scans of daily_ai_usage + classified comments; pre-aggregate per day if the
    // dashboard gets slow (both grow with traffic).
    const [credit, modelRows, decisionRows, analyzed] = await Promise.all([
      this.db
        .select({
          total: sql<string>`coalesce(sum(${aiCreditTopups.amountUsd}), 0)`,
        })
        .from(aiCreditTopups),
      this.db
        .select({
          provider: dailyAiUsage.provider,
          model: dailyAiUsage.model,
          calls: sql<number>`sum(${dailyAiUsage.calls})::int`,
          inputTokens: sql<string>`sum(${dailyAiUsage.inputTokens})`,
          outputTokens: sql<string>`sum(${dailyAiUsage.outputTokens})`,
        })
        .from(dailyAiUsage)
        .groupBy(dailyAiUsage.provider, dailyAiUsage.model),
      this.db
        .select({
          decision,
          provider: comments.aiProvider,
          model: comments.model,
          comments: sql<number>`count(*)::int`,
          withoutTokens: sql<number>`(count(*) filter (where ${comments.aiInputTokens} is null or ${comments.aiOutputTokens} is null))::int`,
          inputTokens: sql<string>`coalesce(sum(${comments.aiInputTokens}) filter (where ${comments.aiOutputTokens} is not null), 0)`,
          outputTokens: sql<string>`coalesce(sum(${comments.aiOutputTokens}) filter (where ${comments.aiInputTokens} is not null), 0)`,
        })
        .from(comments)
        .leftJoinLateral(action, sql`true`)
        .where(isNotNull(comments.classifiedAt))
        .groupBy(decision, comments.aiProvider, comments.model),
      this.db
        .select({
          total: count(),
          today: sql<number>`(count(*) filter (where ${comments.classifiedAt} >= ${since.today}))::int`,
          last7Days: sql<number>`(count(*) filter (where ${comments.classifiedAt} >= ${since.last7Days}))::int`,
        })
        .from(comments)
        .where(isNotNull(comments.classifiedAt)),
    ]);

    return buildAiSpendSummary({
      now,
      prices: this.prices,
      creditAddedUsd: Number(credit[0]?.total ?? 0),
      modelRows: modelRows.map((r) => ({
        provider: r.provider,
        model: r.model,
        calls: Number(r.calls),
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
      })),
      decisionRows: decisionRows.flatMap((r): AiDecisionTotalsRow[] =>
        r.provider && r.model
          ? [
              {
                decision: r.decision,
                provider: r.provider,
                model: r.model,
                comments: Number(r.comments),
                withoutTokens: Number(r.withoutTokens),
                inputTokens: Number(r.inputTokens),
                outputTokens: Number(r.outputTokens),
              },
            ]
          : [],
      ),
      commentsAnalyzed: {
        total: Number(analyzed[0]?.total ?? 0),
        today: Number(analyzed[0]?.today ?? 0),
        last7Days: Number(analyzed[0]?.last7Days ?? 0),
      },
    });
  }

  async listTopups(): Promise<AiCreditTopupsResponse> {
    const rows = await this.db
      .select({
        id: aiCreditTopups.id,
        amountUsd: aiCreditTopups.amountUsd,
        toppedUpOn: aiCreditTopups.toppedUpOn,
        note: aiCreditTopups.note,
        createdAt: aiCreditTopups.createdAt,
        creatorId: users.id,
        creatorName: users.name,
      })
      .from(aiCreditTopups)
      .innerJoin(users, eq(users.id, aiCreditTopups.createdById))
      .orderBy(
        desc(aiCreditTopups.toppedUpOn),
        desc(aiCreditTopups.createdAt),
        desc(aiCreditTopups.id),
      );
    return {
      items: rows.map(({ creatorId, creatorName, ...topup }) => ({
        ...topup,
        createdBy: { id: creatorId, name: creatorName },
      })),
    };
  }

  async addTopup(
    input: CreateAiCreditTopupDto,
    actor: TopupActor,
  ): Promise<{ topup: AiCreditTopup }> {
    if (input.toppedUpOn > dhakaDate(this.now())) {
      throw new BadRequestException({
        message: 'toppedUpOn must not be in the future',
        code: 'TOPUP_DATE_IN_FUTURE',
      });
    }
    const note = input.note ?? null;
    const row = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(aiCreditTopups)
        .values({
          amountUsd: input.amountUsd,
          toppedUpOn: input.toppedUpOn,
          note,
          createdById: actor.adminId,
        })
        .returning();
      await tx.insert(aiCreditTopupAuditLogs).values({
        adminId: actor.adminId,
        action: 'add',
        topupId: created!.id,
        amountUsd: created!.amountUsd,
        toppedUpOn: created!.toppedUpOn,
        note: created!.note,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      return created!;
    });
    return {
      topup: {
        id: row.id,
        amountUsd: row.amountUsd,
        toppedUpOn: row.toppedUpOn,
        note: row.note,
        createdAt: row.createdAt,
        createdBy: { id: actor.adminId, name: actor.adminName },
      },
    };
  }

  async deleteTopup(id: string, actor: TopupActor): Promise<void> {
    if (!UUID.test(id)) throw new NotFoundException('Top-up not found');
    const deleted = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(aiCreditTopups)
        .where(eq(aiCreditTopups.id, id))
        .returning();
      if (!row) return false;
      await tx.insert(aiCreditTopupAuditLogs).values({
        adminId: actor.adminId,
        action: 'delete',
        topupId: row.id,
        amountUsd: row.amountUsd,
        toppedUpOn: row.toppedUpOn,
        note: row.note,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      return true;
    });
    if (!deleted) throw new NotFoundException('Top-up not found');
  }
}

function toDecision(action: string | null): AiDecision {
  return action === 'HIDE' || action === 'DELETE' ? action : 'NONE';
}
