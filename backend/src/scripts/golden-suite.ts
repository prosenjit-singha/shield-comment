import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { aiEnvSettingsFromConfig } from '../ai-gateway/ai-gateway.module.js';
import { AiGatewayError } from '../ai-gateway/ai-gateway.errors.js';
import {
  AiGatewayService,
  MODERATION_TIMEOUT_MS,
} from '../ai-gateway/ai-gateway.service.js';
import type {
  AiConfigResolver,
  AiProviderConfig,
} from '../ai-gateway/ai-provider.js';
import {
  type AiSettingsSnapshot,
  buildAiSettingsSnapshot,
  draftAiConfig,
} from '../ai-gateway/ai-settings.rules.js';
import { DbAiConfigResolver } from '../ai-gateway/db-ai-config.resolver.js';
import {
  isSystemOneModel,
  SystemOneAdapter,
} from '../ai-gateway/systemone.adapter.js';
import { relaxHappyEyeballsTimeout } from '../common/net/happy-eyeballs.js';
import {
  type EnvironmentVariables,
  validateEnv,
} from '../config/env.validation.js';
import { createTokenKeyring } from '../crypto/token-cipher.config.js';
import { TokenCipherService } from '../crypto/token-cipher.service.js';
import * as schema from '../db/schema/index.js';
import {
  GOLDEN_USAGE,
  type GoldenArgs,
  GoldenArgsError,
  parseGoldenArgs,
  selectGoldenItems,
} from '../moderation/golden-args.js';
import { normalizeClassifierInput } from '../moderation/classifier-input.js';
import {
  type GoldenComment,
  goldenClassifierInput,
  validateGoldenFixture,
} from '../moderation/golden-fixture.js';
import {
  buildGoldenReplay,
  type GoldenRunResult,
  goldenReplayFileName,
  runGoldenSuite,
} from '../moderation/golden-replay.js';
import {
  formatGoldenReport,
  type GoldenOutcome,
  modelPrice,
  scoreGolden,
} from '../moderation/golden-score.js';
import {
  JEV_PROMPT_VERSION,
  JEV_QUESTIONS,
  jevDecision,
  jevState,
} from '../moderation/jev-moderation.js';
import type { ContextLevel } from '../moderation/moderation.constants.js';
import { PROMPT_VERSION } from '../moderation/moderation-prompt.js';

/**
 * `npm run ai:golden -- [--provider p] [--model m] [--level l] [--language l] [--limit n] [--record]` (after
 * `npm run build`; M5-T6, D12). Classifies `test/fixtures/golden-comments.ts` with LIVE calls (costs
 * money) through `CommentClassifier`, prints accuracy / precision / recall / confusion / tokens /
 * latency / estimated cost, exits 1 below 90 % (or when the provider has no key / no credits).
 * Config = the D16 resolver rules (DB settings → `.env`, per field); `--provider/--model` override.
 * `--record` writes `test/fixtures/golden-responses.<provider>.<model>.json` for the CI replay.
 * A System One model (Jev, `--provider neon --model typesafeai-jev-1-14-0`) runs through the
 * `systemone` adapter + `jev-moderation.ts` instead of the chat classifier (M5-T15a; no `--record`).
 * Never prints keys. Host only (the fixture is TypeScript under test/, loaded by Node's type stripping).
 *   cd backend && npm run build && npm run ai:golden -- --provider openai --limit 5
 */
const BACKEND_ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE_PATH = resolve(BACKEND_ROOT, 'test/fixtures/golden-comments.ts');
const FIXTURE_DIR = resolve(BACKEND_ROOT, 'test/fixtures');
/** Every later call would fail the same way: stop instead of burning through the fixture. */
const FATAL_KINDS = ['not_configured', 'payment_required', 'auth'] as const;
const FATAL_HINTS: Record<(typeof FATAL_KINDS)[number], string> = {
  not_configured:
    'the provider is not configured (no API key, or no NEON_AI_GATEWAY_BASE_URL for neon). Set it in /admin/settings or .env.',
  payment_required:
    'the provider refused for billing (no credits / paid plan required). Add credits or pick another provider.',
  auth: 'the provider rejected the API key. Check the key in /admin/settings or .env.',
};

class CleanExit extends Error {}

type ItemPrinter = (
  outcome: GoldenOutcome,
  index: number,
  detail?: string,
) => void;

type SuiteRun = Pick<GoldenRunResult, 'outcomes' | 'aborted'> &
  Partial<Pick<GoldenRunResult, 'calls'>>;

/** One System One call per item (no retries: a smoke run), sequential like `runGoldenSuite`. */
async function runSystemOneSuite(
  items: readonly GoldenComment[],
  config: AiProviderConfig,
  contextLevel: ContextLevel,
  print: ItemPrinter,
): Promise<SuiteRun> {
  const adapter = new SystemOneAdapter();
  const outcomes: GoldenOutcome[] = [];
  for (const [index, item] of items.entries()) {
    const input = normalizeClassifierInput(
      goldenClassifierInput(item, contextLevel),
    );
    const started = performance.now();
    const ms = () => Math.max(0, Math.round(performance.now() - started));
    let outcome: GoldenOutcome;
    let detail: string | undefined;
    let fatal: AiGatewayError | undefined;
    if (!input) {
      outcome = {
        item,
        result: { ok: false, kind: 'empty_text' },
        latencyMs: 0,
        attempts: 0,
      };
    } else {
      try {
        const res = await adapter.decide(config, {
          model: config.model,
          state: jevState(input),
          questions: JEV_QUESTIONS,
          timeoutMs: MODERATION_TIMEOUT_MS,
        });
        outcome = {
          item,
          result: {
            ok: true,
            ...jevDecision(res.nouls),
            outputMode: 'systemone',
          },
          latencyMs: ms(),
          attempts: 1,
          ...(res.usage && { usage: res.usage }),
        };
        detail = Object.entries(res.nouls)
          .map(([id, p]) => `${id} ${p.toFixed(2)}`)
          .join(' · ');
      } catch (error) {
        if (!(error instanceof AiGatewayError)) throw error;
        outcome = {
          item,
          result: { ok: false, kind: error.kind },
          latencyMs: ms(),
          attempts: 1,
        };
        detail = error.message;
        if ((FATAL_KINDS as readonly string[]).includes(error.kind)) {
          fatal = error;
        }
      }
    }
    outcomes.push(outcome);
    print(outcome, index, detail);
    if (fatal) {
      return {
        outcomes,
        aborted: { itemId: item.id, kind: fatal.kind, status: fatal.status },
      };
    }
  }
  return { outcomes };
}

function fail(message: string): never {
  console.error(`ai:golden: ${message}`);
  throw new CleanExit(message);
}

async function loadSnapshot(
  env: EnvironmentVariables,
): Promise<{ snapshot: AiSettingsSnapshot; source: string; pool: Pool }> {
  const config = new ConfigService<EnvironmentVariables, true>(env);
  const envSettings = aiEnvSettingsFromConfig(config);
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  const resolver = new DbAiConfigResolver(
    db,
    new TokenCipherService(createTokenKeyring(config)),
    envSettings,
  );
  try {
    return {
      snapshot: await resolver.state(),
      source: 'DB settings → .env',
      pool,
    };
  } catch (error) {
    console.warn(
      `ai:golden: could not read the AI settings from the database (${error instanceof Error ? error.name : 'unknown'}); using .env only`,
    );
    return {
      snapshot: buildAiSettingsSnapshot(
        {
          provider: null,
          model: null,
          textImageModel: null,
          textImageEnabled: false,
        },
        {},
        envSettings,
      ),
      source: '.env only',
      pool,
    };
  }
}

function parseArgsOrExit(argv: readonly string[]): GoldenArgs {
  try {
    return parseGoldenArgs(argv);
  } catch (error) {
    if (error instanceof GoldenArgsError) {
      console.error(`ai:golden: ${error.message}\n\n${GOLDEN_USAGE}`);
      throw new CleanExit(error.message);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgsOrExit(process.argv.slice(2));
  if (args.help) {
    console.log(GOLDEN_USAGE);
    return;
  }

  let env: EnvironmentVariables;
  try {
    env = validateEnv(process.env);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const fixture = validateGoldenFixture(
    (
      (await import(pathToFileURL(FIXTURE_PATH).href)) as {
        GOLDEN_COMMENTS?: unknown;
      }
    ).GOLDEN_COMMENTS,
  );
  const items = selectGoldenItems(fixture, args);

  const { snapshot, source, pool } = await loadSnapshot(env);
  await pool.end();
  const provider = args.provider ?? snapshot.provider;
  const config = draftAiConfig(snapshot, {
    provider,
    ...(args.model && { model: args.model }),
  });
  if (!config) {
    fail(
      `not_configured: ${provider} has no API key${provider === 'neon' ? ' or no NEON_AI_GATEWAY_BASE_URL' : ''} (config from ${source}). Set it in /admin/settings or .env. No call was made.`,
    );
  }
  const systemOne = isSystemOneModel(config.model);
  if (systemOne && args.record) {
    fail(
      `--record is not supported for System One models yet (${config.model}). No call was made.`,
    );
  }
  const promptVersion = systemOne ? JEV_PROMPT_VERSION : PROMPT_VERSION;
  console.log(
    `ai:golden: ${items.length} comments · ${config.provider} / ${config.model} · key from ${snapshot.keys[config.provider].source} · level ${args.contextLevel}${args.language ? ` · language ${args.language}` : ''} · prompt ${promptVersion} · LIVE calls`,
  );

  // Library logs (classifier / gateway) carry no comment text, but they would clutter the report.
  Logger.overrideLogger(['error']);
  const print: ItemPrinter = (outcome, index, detail) => {
    const got = outcome.result.ok
      ? `${outcome.result.category} [${outcome.result.outputMode ?? '?'}]`
      : `failed: ${outcome.result.kind}`;
    const mark =
      outcome.result.ok && outcome.result.category === outcome.item.expected
        ? 'ok '
        : 'XX ';
    console.log(
      `${mark}${String(index + 1).padStart(2)}/${items.length} ${outcome.item.id} → ${got} (${outcome.latencyMs} ms)${detail ? ` · ${detail}` : ''}`,
    );
  };
  const unusedResolver: AiConfigResolver = { resolve: async () => config };
  const run: SuiteRun = systemOne
    ? await runSystemOneSuite(items, config, args.contextLevel, print)
    : await runGoldenSuite(items, {
        chat: new AiGatewayService(unusedResolver),
        contextLevel: args.contextLevel,
        config,
        abortOn: FATAL_KINDS,
        onItem: (outcome, index) => print(outcome, index),
      });
  if (run.aborted) {
    const kind = run.aborted.kind as (typeof FATAL_KINDS)[number];
    fail(
      `stopped at ${run.aborted.itemId}: ${kind}${run.aborted.status ? ` (HTTP ${run.aborted.status})` : ''}: ${FATAL_HINTS[kind]}${args.record ? ' Nothing was recorded.' : ''}`,
    );
  }

  const report = scoreGolden(
    run.outcomes,
    modelPrice(config.provider, config.model),
  );
  console.log('');
  console.log(
    formatGoldenReport(report, {
      provider: config.provider,
      model: config.model,
      level: args.contextLevel,
      promptVersion,
      source: 'live',
    }),
  );

  if (args.record && run.calls) {
    const file = buildGoldenReplay({
      source: 'recorded',
      provider: config.provider,
      model: config.model,
      promptVersion: PROMPT_VERSION,
      contextLevel: args.contextLevel,
      recordedAt: new Date(),
      items,
      calls: run.calls,
    });
    const path = resolve(
      FIXTURE_DIR,
      goldenReplayFileName(config.provider, config.model),
    );
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    console.log(`\nRecorded ${items.length} items → ${path}`);
  }
  if (!report.passed) process.exitCode = 1;
}

relaxHappyEyeballsTimeout();
try {
  await main();
} catch (error) {
  if (!(error instanceof CleanExit)) {
    console.error(
      `ai:golden failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
}
