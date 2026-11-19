import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { GOLDEN_COMMENTS } from '../../test/fixtures/golden-comments.js';
import type { ChatOptions } from '../ai-gateway/ai-gateway.service.js';
import type { GoldenComment } from './golden-fixture.js';
import {
  buildGoldenReplay,
  GOLDEN_REPLAY_FILE_PATTERN,
  type GoldenReplayFile,
  GoldenReplayError,
  goldenReplayFileName,
  goldenTextDigest,
  parseGoldenReplay,
  ReplayAiChat,
  runGoldenSuite,
} from './golden-replay.js';
import { GOLDEN_PASS_ACCURACY, scoreGolden } from './golden-score.js';
import { PROMPT_VERSION } from './moderation-prompt.js';

const FIXTURE_DIR = resolve(import.meta.dirname, '../../test/fixtures');
const HAND_MADE = 'golden-responses.neon.handmade-replay.json';
const items: readonly GoldenComment[] = GOLDEN_COMMENTS;

function readReplay(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8'));
}

function handMade(): GoldenReplayFile {
  return parseGoldenReplay(readReplay(HAND_MADE), {
    promptVersion: PROMPT_VERSION,
    name: HAND_MADE,
  });
}

function item(id: string): GoldenComment {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`no fixture item ${id}`);
  return found;
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => {});
  }
});
afterEach(() => vi.restoreAllMocks());

describe('golden replay file', () => {
  it('is named golden-responses.<provider>.<model>.json with a safe model part', () => {
    expect(goldenReplayFileName('openai', 'gpt-4.1-mini')).toBe(
      'golden-responses.openai.gpt-4.1-mini.json',
    );
    expect(goldenReplayFileName('neon', 'meta/llama 3:70b')).toBe(
      'golden-responses.neon.meta_llama_3_70b.json',
    );
    expect(
      GOLDEN_REPLAY_FILE_PATTERN.test(
        goldenReplayFileName('google', 'gemini-2.5-flash-lite'),
      ),
    ).toBe(true);
  });

  it('loads the hand-made replay: clearly labelled, current prompt, every fixture item', () => {
    const file = handMade();
    expect(file.source).toBe('hand-made');
    expect(file.note).toMatch(/^HAND-MADE replay/);
    expect(file.promptVersion).toBe(PROMPT_VERSION);
    expect(Object.keys(file.items)).toEqual(items.map((i) => i.id));
  });

  it('fails loudly on a recording for another prompt version', () => {
    const stale = {
      ...(readReplay(HAND_MADE) as object),
      promptVersion: 'moderation-v0',
    };
    expect(() =>
      parseGoldenReplay(stale, {
        promptVersion: PROMPT_VERSION,
        name: 'x.json',
      }),
    ).toThrow(
      new GoldenReplayError(
        `x.json was recorded for prompt moderation-v0, but PROMPT_VERSION is ${PROMPT_VERSION}: re-record it (npm run ai:golden -- --record) or delete it`,
      ),
    );
  });

  it.each([
    ['not an object', []],
    ['format', { format: 2 }],
    ['source', { source: 'guessed' }],
    ['provider', { provider: 'mistral' }],
    ['model', { model: '' }],
    ['contextLevel', { contextLevel: 'everything' }],
    ['item safe-01', { items: { 'safe-01': { textSha256: 'x', calls: [] } } }],
    [
      'item safe-01',
      {
        items: {
          'safe-01': {
            textSha256: 'x',
            calls: [{ content: 'x', latencyMs: 1 }],
          },
        },
      },
    ],
    [
      'item safe-01',
      {
        items: {
          'safe-01': {
            textSha256: 'x',
            calls: [{ error: { kind: 'timeout' }, latencyMs: 1 }],
          },
        },
      },
    ],
  ])('rejects a bad shape (%s)', (what, patch) => {
    const value = Array.isArray(patch)
      ? patch
      : { ...(readReplay(HAND_MADE) as object), ...patch };
    expect(() =>
      parseGoldenReplay(value, { promptVersion: PROMPT_VERSION }),
    ).toThrow(`golden replay: invalid replay file (${what})`);
  });
});

describe('ReplayAiChat', () => {
  const file = (): GoldenReplayFile => handMade();

  it('fails clearly when an item has no recording (before any call)', async () => {
    const replay = new ReplayAiChat(file(), 'test.json');
    const extra: GoldenComment = { ...item('safe-01'), id: 'safe-99' };
    await expect(
      runGoldenSuite([extra], { chat: replay, contextLevel: 'comment_only' }),
    ).rejects.toThrow(
      new GoldenReplayError(
        'test.json has no recording for safe-99: re-record it (npm run ai:golden -- --record)',
      ),
    );
  });

  it('fails when the fixture text changed since the recording', async () => {
    const replay = new ReplayAiChat(file(), 'test.json');
    const edited: GoldenComment = { ...item('safe-01'), text: 'দাম কত?' };
    await expect(
      runGoldenSuite([edited], { chat: replay, contextLevel: 'comment_only' }),
    ).rejects.toThrow(
      'test.json: the text of safe-01 changed since it was recorded: re-record it',
    );
  });

  it('throws on a call the recording does not have', async () => {
    const recorded = file();
    // abuse-04 answers invalid output twice; with one call left the classifier's retry is unexpected.
    recorded.items['abuse-04'] = {
      ...recorded.items['abuse-04']!,
      calls: recorded.items['abuse-04']!.calls.slice(0, 1),
    };
    const replay = new ReplayAiChat(recorded);
    await expect(
      runGoldenSuite([item('abuse-04')], {
        chat: replay,
        contextLevel: 'comment_only',
      }),
    ).rejects.toThrow(
      'Unexpected AiGatewayService.chat call #2 for abuse-04: only 1 recorded',
    );
    await expect(new ReplayAiChat(recorded).chat([])).rejects.toThrow(
      'Unexpected AiGatewayService.chat call outside a golden item',
    );
  });

  it('fails when recorded calls were not used', async () => {
    const recorded = file();
    const safe = recorded.items['safe-01']!;
    recorded.items['safe-01'] = {
      ...safe,
      calls: [...safe.calls, ...safe.calls],
    };
    await expect(
      runGoldenSuite([item('safe-01')], {
        chat: new ReplayAiChat(recorded),
        contextLevel: 'comment_only',
      }),
    ).rejects.toThrow(
      'golden replay: safe-01 made 1 calls but 2 were recorded',
    );
  });
});

describe('golden suite through CommentClassifier (CI replay, no network)', () => {
  it('scores the hand-made replay: pipeline + scorer', async () => {
    const replay = new ReplayAiChat(handMade(), HAND_MADE);
    const chat = vi.spyOn(replay, 'chat');
    const run = await runGoldenSuite(items, {
      chat: replay,
      contextLevel: 'comment_only',
    });
    expect(run.aborted).toBeUndefined();
    const report = scoreGolden(run.outcomes);
    expect(report).toMatchObject({
      total: 48,
      correct: 45,
      failed: 1,
      passed: true,
    });
    expect(report.accuracy).toBeCloseTo(45 / 48, 10);
    expect(report.failuresByKind).toEqual({ invalid_output: 1 });
    expect(report.mistakes.map((m) => [m.id, m.got])).toEqual([
      ['comp-07', 'SAFE_INQUIRY'],
      ['spam-05', 'SCAM_PHISHING'],
      ['abuse-04', 'FAILED'],
    ]);
    expect(report.perCategory.SCAM_PHISHING).toMatchObject({
      support: 10,
      predicted: 11,
      truePositives: 10,
      recall: 1,
    });
    expect(report.perCategory.SCAM_PHISHING.precision).toBeCloseTo(10 / 11, 10);
    expect(report.perCategory.ABUSIVE_TOXIC).toMatchObject({
      support: 11,
      predicted: 10,
      precision: 1,
    });
    expect(report.perCategory.ABUSIVE_TOXIC.recall).toBeCloseTo(10 / 11, 10);
    expect(report.attempts).toEqual({ total: 51, max: 2 });
    expect(chat).toHaveBeenCalledTimes(51);
    expect(report.tokens.itemsWithUsage).toBe(48);
    expect(report.latency?.maxMs).toBeGreaterThan(0);

    // The classifier got the fixture comment as data, and fell back after the response_format refusal.
    const safe03 = items.findIndex((i) => i.id === 'safe-03');
    const calls = chat.mock.calls;
    const safe03First = calls[safe03 + 0]!; // safe-01, safe-02 make one call each before it
    expect(safe03First[0].at(-1)?.content).toContain(
      JSON.stringify(item('safe-03').text),
    );
    expect((safe03First[1] as ChatOptions).responseFormat?.type).toBe(
      'json_schema',
    );
    expect((calls[safe03 + 1]![1] as ChatOptions).responseFormat?.type).toBe(
      'json_object',
    );
    const outcome = run.outcomes.find((o) => o.item.id === 'safe-03');
    expect(outcome).toMatchObject({
      result: { ok: true, category: 'SAFE_INQUIRY' },
      attempts: 2,
    });
  });

  it('round-trips a run through buildGoldenReplay → parse → replay', async () => {
    const first = await runGoldenSuite(items.slice(0, 5), {
      chat: new ReplayAiChat(handMade()),
      contextLevel: 'comment_only',
    });
    const file = buildGoldenReplay({
      source: 'recorded',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      promptVersion: PROMPT_VERSION,
      contextLevel: 'comment_only',
      recordedAt: new Date('2026-11-19T10:00:00Z'),
      items: items.slice(0, 5),
      calls: first.calls,
    });
    expect(file.items['safe-01']?.textSha256).toBe(
      goldenTextDigest(item('safe-01').text),
    );
    const parsed = parseGoldenReplay(JSON.parse(JSON.stringify(file)), {
      promptVersion: PROMPT_VERSION,
    });
    const second = await runGoldenSuite(items.slice(0, 5), {
      chat: new ReplayAiChat(parsed),
      contextLevel: 'comment_only',
    });
    expect(second.outcomes.map((o) => o.result)).toEqual(
      first.outcomes.map((o) => o.result),
    );
    expect(() =>
      buildGoldenReplay({
        ...file,
        recordedAt: new Date(),
        items: items.slice(0, 6),
        calls: first.calls,
        source: 'recorded',
      }),
    ).toThrow(new GoldenReplayError(`no captured calls for ${items[5]!.id}`));
  });

  it('stops at the first abortOn failure (script: no key / no credits / bad key)', async () => {
    const file = handMade();
    file.items['safe-02'] = {
      ...file.items['safe-02']!,
      calls: [
        {
          error: {
            kind: 'payment_required',
            status: 403,
            message: 'AI neon 403: paid_plan_required',
          },
          latencyMs: 3,
        },
      ],
    };
    const run = await runGoldenSuite(items, {
      chat: new ReplayAiChat(file),
      contextLevel: 'comment_only',
      abortOn: ['not_configured', 'payment_required', 'auth'],
    });
    expect(run.aborted).toEqual({
      itemId: 'safe-02',
      kind: 'payment_required',
      status: 403,
    });
    expect(run.outcomes).toHaveLength(2);
  });

  const recorded = readdirSync(FIXTURE_DIR)
    .filter(
      (name) => GOLDEN_REPLAY_FILE_PATTERN.test(name) && name !== HAND_MADE,
    )
    .sort();
  if (recorded.length === 0) {
    it.skip('recorded replays: none yet (M5-T16 records them with npm run ai:golden -- --record)', () => {});
  }
  it.each(recorded)(
    'replays %s: every fixture item, accuracy at least 0.9',
    async (name) => {
      const file = parseGoldenReplay(readReplay(name), {
        promptVersion: PROMPT_VERSION,
        name,
      });
      expect(file.source).toBe('recorded');
      const run = await runGoldenSuite(items, {
        chat: new ReplayAiChat(file, name),
        contextLevel: file.contextLevel,
      });
      const report = scoreGolden(run.outcomes);
      expect(
        report.accuracy,
        `${name}: ${report.correct}/${report.total}; mistakes ${report.mistakes.map((m) => m.id).join(', ')}`,
      ).toBeGreaterThanOrEqual(GOLDEN_PASS_ACCURACY);
    },
  );
});
