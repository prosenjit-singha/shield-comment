import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import {
  ListAiSettingsAuditQueryDto,
  TestAiConnectionDto,
  UpdateAiSettingsDto,
} from './ai-settings.dto.js';

/** Same options as the global ValidationPipe (src/app.setup.ts). */
async function check<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
) {
  const dto = plainToInstance(cls, plain);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: false,
  });
  return { dto, fields: errors.flatMap((e) => paths(e)) };
}

function paths(error: ValidationError, prefix = ''): string[] {
  const path = prefix ? `${prefix}.${error.property}` : error.property;
  const own = error.constraints ? [path] : [];
  return [...own, ...(error.children ?? []).flatMap((c) => paths(c, path))];
}

const KEY = 'sk-test-key-1234';

describe('UpdateAiSettingsDto', () => {
  it('accepts a full valid body and trims model + keys', async () => {
    const { dto, fields } = await check(UpdateAiSettingsDto, {
      provider: 'anthropic',
      model: '  claude-haiku-4-5 ',
      keys: { anthropic: ` ${KEY}\n`, openai: null },
    });
    expect(fields).toEqual([]);
    expect(dto.model).toBe('claude-haiku-4-5');
    expect(dto.keys?.anthropic).toBe(KEY);
    expect(dto.keys?.openai).toBeNull();
    expect(dto.keys?.google).toBeUndefined();
  });

  it('provider must be one of the four (null is not "absent")', async () => {
    for (const provider of ['mistral', null, 1, '']) {
      expect((await check(UpdateAiSettingsDto, { provider })).fields).toEqual([
        'provider',
      ]);
    }
    for (const provider of ['neon', 'openai', 'anthropic', 'google']) {
      expect((await check(UpdateAiSettingsDto, { provider })).fields).toEqual(
        [],
      );
    }
  });

  it('model: 1–100 printable chars without spaces, null clears', async () => {
    expect((await check(UpdateAiSettingsDto, { model: null })).fields).toEqual(
      [],
    );
    expect(
      (await check(UpdateAiSettingsDto, { model: 'm'.repeat(100) })).fields,
    ).toEqual([]);
    for (const model of ['', '   ', 'm'.repeat(101), 'gpt 4', 'gpt-ö', 7]) {
      expect((await check(UpdateAiSettingsDto, { model })).fields).toEqual([
        'model',
      ]);
    }
  });

  it('keys: 8–500 printable chars, null clears, unknown provider rejected', async () => {
    expect(
      (await check(UpdateAiSettingsDto, { keys: { neon: 'x'.repeat(8) } }))
        .fields,
    ).toEqual([]);
    expect(
      (await check(UpdateAiSettingsDto, { keys: { neon: 'x'.repeat(500) } }))
        .fields,
    ).toEqual([]);
    for (const bad of [
      'x'.repeat(7),
      'x'.repeat(501),
      'sk key 1234',
      'sk-\u0007-key-1',
      42,
    ]) {
      expect(
        (await check(UpdateAiSettingsDto, { keys: { google: bad } })).fields,
      ).toEqual(['keys.google']);
    }
    expect(
      (await check(UpdateAiSettingsDto, { keys: { mistral: KEY } })).fields,
    ).toEqual(['keys.mistral']);
    expect((await check(UpdateAiSettingsDto, { keys: 'x' })).fields).toEqual([
      'keys',
    ]);
    expect((await check(UpdateAiSettingsDto, { keys: null })).fields).toEqual([
      'keys',
    ]);
  });

  it('rejects unknown fields; the service rejects an empty body', async () => {
    expect((await check(UpdateAiSettingsDto, { apiKey: KEY })).fields).toEqual([
      'apiKey',
    ]);
    expect((await check(UpdateAiSettingsDto, {})).fields).toEqual([]);
  });
});

describe('TestAiConnectionDto', () => {
  it('everything optional; draft fields validated like the PATCH', async () => {
    expect((await check(TestAiConnectionDto, {})).fields).toEqual([]);
    const { dto, fields } = await check(TestAiConnectionDto, {
      provider: 'google',
      model: ' gemini-2.5-flash-lite ',
      apiKey: ` ${KEY} `,
    });
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ model: 'gemini-2.5-flash-lite', apiKey: KEY });
  });

  it('rejects bad / null draft values and unknown fields', async () => {
    const { fields } = await check(TestAiConnectionDto, {
      provider: 'x',
      model: null,
      apiKey: 'short',
      keys: {},
    });
    expect(fields.sort()).toEqual(['apiKey', 'keys', 'model', 'provider']);
  });
});

describe('ListAiSettingsAuditQueryDto', () => {
  it('defaults and bounds', async () => {
    const { dto, fields } = await check(ListAiSettingsAuditQueryDto, {});
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ skip: 0, take: 50 });
    expect(
      (await check(ListAiSettingsAuditQueryDto, { skip: '-1', take: '101' }))
        .fields,
    ).toEqual(['skip', 'take']);
    expect(
      (await check(ListAiSettingsAuditQueryDto, { planId: 'x' })).fields,
    ).toEqual(['planId']);
  });
});
