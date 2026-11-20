import { NEON_MODEL_CATALOG } from '../ai-gateway/neon-model-catalog.js';
import {
  DEFAULT_AI_MODEL_PRICES,
  lookupModelPrice,
  mergeModelPrices,
  neonCatalogPrices,
  parseModelPrices,
} from './ai-model-prices.js';

describe('parseModelPrices (AI_MODEL_PRICES)', () => {
  it('parses comma-separated provider:model=input/output entries', () => {
    expect(
      parseModelPrices(
        ' neon:gpt-oss-20b=0.05/0.2 , openai:gpt-4.1-mini=0.4/1.6,,neon:org/model:v1=1/2',
      ),
    ).toEqual({
      neon: {
        'gpt-oss-20b': { input: 0.05, output: 0.2 },
        'org/model:v1': { input: 1, output: 2 },
      },
      openai: { 'gpt-4.1-mini': { input: 0.4, output: 1.6 } },
    });
  });

  it('blank → no entries', () => {
    expect(parseModelPrices('')).toEqual({});
    expect(parseModelPrices(' , ')).toEqual({});
  });

  it.each([
    ['gpt-4.1-mini=0.4/1.6', 'entry 1 must look like'],
    [':m=1/2', 'entry 1 must look like'],
    ['neon:=1/2', 'entry 1 must look like'],
    ['openai:a=1/2,azure:m=1/2', 'entry 2: provider must be one of'],
    ['neon:m=1', 'price must be'],
    ['neon:m=1/2/3', 'price must be'],
    ['neon:m=-1/2', 'price must be'],
    ['neon:m=1e3/2', 'price must be'],
    ['neon:m=1001/2', 'price must be'],
    ['neon:m=1/2,neon:m=3/4', 'entry 2: duplicate neon:m'],
    [`neon:${'x'.repeat(101)}=1/2`, 'model must be 1–100'],
  ])('rejects %j', (text, message) => {
    expect(() => parseModelPrices(text)).toThrow(message);
  });
});

describe('mergeModelPrices + lookupModelPrice', () => {
  it('adds new models and replaces existing ones; the base is not changed', () => {
    const merged = mergeModelPrices(
      DEFAULT_AI_MODEL_PRICES,
      parseModelPrices('neon:gpt-oss-20b=0.05/0.2,openai:gpt-4.1-mini=0.5/2'),
    );
    expect(lookupModelPrice(merged, 'neon', 'gpt-oss-20b')).toEqual({
      input: 0.05,
      output: 0.2,
    });
    expect(lookupModelPrice(merged, 'openai', 'gpt-4.1-mini')).toEqual({
      input: 0.5,
      output: 2,
    });
    expect(lookupModelPrice(merged, 'openai', 'gpt-4.1-nano')).toEqual({
      input: 0.1,
      output: 0.4,
    });
    expect(
      lookupModelPrice(DEFAULT_AI_MODEL_PRICES, 'openai', 'gpt-4.1-mini'),
    ).toEqual({ input: 0.4, output: 1.6 });
  });

  it('unknown provider/model (incl. prototype names) → null', () => {
    expect(
      lookupModelPrice(DEFAULT_AI_MODEL_PRICES, 'neon', 'unlisted-model'),
    ).toBeNull();
    expect(
      lookupModelPrice(DEFAULT_AI_MODEL_PRICES, 'openai', 'gpt-9'),
    ).toBeNull();
    expect(
      lookupModelPrice(DEFAULT_AI_MODEL_PRICES, 'openai', 'constructor'),
    ).toBeNull();
    expect(parseModelPrices('openai:constructor=1/2').openai).toEqual({
      constructor: { input: 1, output: 2 },
    });
  });
});

describe('neon prices from the catalog (M5-T15b)', () => {
  it('every priced catalog model has its list price, no duplicated numbers', () => {
    for (const m of NEON_MODEL_CATALOG) {
      expect(lookupModelPrice(DEFAULT_AI_MODEL_PRICES, 'neon', m.code)).toEqual(
        { input: m.inputUsdPer1M, output: m.outputUsdPer1M },
      );
    }
  });

  it('free → 0, jev output → 0 (input-only billing)', () => {
    expect(
      lookupModelPrice(DEFAULT_AI_MODEL_PRICES, 'neon', 'gemini-4-carbon'),
    ).toEqual({ input: 0, output: 0 });
    expect(
      lookupModelPrice(
        DEFAULT_AI_MODEL_PRICES,
        'neon',
        'typesafeai-jev-1-14-0',
      ),
    ).toEqual({ input: 0.042, output: 0 });
  });

  it('an unpublished price → no entry (cost n/a)', () => {
    const [first] = NEON_MODEL_CATALOG;
    expect(
      neonCatalogPrices([
        { ...first!, code: 'no-output', outputUsdPer1M: null },
        { ...first!, code: 'no-input', inputUsdPer1M: null },
        { ...first!, code: 'priced', inputUsdPer1M: 1, outputUsdPer1M: 2 },
      ]),
    ).toEqual({ priced: { input: 1, output: 2 } });
  });
});
