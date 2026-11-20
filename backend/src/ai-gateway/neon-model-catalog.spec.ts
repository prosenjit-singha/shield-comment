import { DEFAULT_AI_MODELS } from './ai-provider.js';
import {
  acceptsTemperature,
  DEFAULT_TEXT_IMAGE_MODEL,
  NEON_MODEL_CATALOG,
  NEON_MODEL_INPUTS,
  neonModel,
  supportsImages,
} from './neon-model-catalog.js';
import { isSystemOneModel } from './systemone.adapter.js';

describe('NEON_MODEL_CATALOG', () => {
  it('flags the models that take no temperature (/v1/models, M5-T16)', () => {
    expect(
      NEON_MODEL_CATALOG.filter((m) => !m.temperature).map((m) => m.code),
    ).toEqual(['gemini-4-carbon', 'typesafeai-jev-1-14-0', 'claude-haiku-5-5']);
    expect(acceptsTemperature('gpt-oss-120b')).toBe(true);
    expect(acceptsTemperature('some-new-model')).toBe(true);
    expect(acceptsTemperature('claude-haiku-5-5')).toBe(false);
  });

  it('holds the five D19 models, unique codes', () => {
    expect(NEON_MODEL_CATALOG.map((m) => m.code)).toEqual([
      'gemini-4-carbon',
      'typesafeai-jev-1-14-0',
      'claude-haiku-5-5',
      'gpt-oss-20b',
      'gpt-oss-120b',
    ]);
  });

  it.each(NEON_MODEL_CATALOG.map((m) => [m.code, m] as const))(
    '%s has a valid shape',
    (_code, m) => {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.lab.length).toBeGreaterThan(0);
      expect(m.inputs).toContain('text');
      for (const input of m.inputs) expect(NEON_MODEL_INPUTS).toContain(input);
      expect(Number.isInteger(m.contextWindow)).toBe(true);
      expect(m.contextWindow).toBeGreaterThan(0);
      for (const price of [m.inputUsdPer1M, m.outputUsdPer1M]) {
        if (price !== null) expect(price).toBeGreaterThanOrEqual(0);
      }
      if (m.free) {
        expect([m.inputUsdPer1M, m.outputUsdPer1M]).toEqual([0, 0]);
      }
      // The dialect flag and the adapter's model match agree.
      expect(m.dialect === 'systemone').toBe(isSystemOneModel(m.code));
    },
  );

  it('records the page facts: Gemini free, Jev input-only billing', () => {
    expect(neonModel('gemini-4-carbon')).toMatchObject({
      free: true,
      inputUsdPer1M: 0,
      outputUsdPer1M: 0,
      contextWindow: 1_048_576,
    });
    expect(neonModel('typesafeai-jev-1-14-0')).toMatchObject({
      free: false,
      inputUsdPer1M: 0.042,
      outputUsdPer1M: 0,
      contextWindow: 65_536,
      dialect: 'systemone',
    });
    expect(neonModel('claude-haiku-5-5')).toMatchObject({
      inputUsdPer1M: 0.1,
      outputUsdPer1M: 0.5,
    });
    expect(neonModel('nope')).toBeUndefined();
  });

  it('supportsImages: only catalog models with image input', () => {
    expect(
      NEON_MODEL_CATALOG.filter((m) => supportsImages(m.code)).map(
        (m) => m.code,
      ),
    ).toEqual(['gemini-4-carbon', 'typesafeai-jev-1-14-0', 'claude-haiku-5-5']);
    expect(supportsImages('gpt-oss-20b')).toBe(false);
    expect(supportsImages('unlisted-vision-model')).toBe(false);
  });

  it('defaults (D22): Text = jev (systemone), Text + Image = Claude Haiku 5.5', () => {
    expect(DEFAULT_AI_MODELS.neon).toBe('typesafeai-jev-1-14-0');
    expect(neonModel(DEFAULT_AI_MODELS.neon)?.dialect).toBe('systemone');
    expect(DEFAULT_TEXT_IMAGE_MODEL).toBe('claude-haiku-5-5');
    expect(supportsImages(DEFAULT_TEXT_IMAGE_MODEL)).toBe(true);
  });
});
