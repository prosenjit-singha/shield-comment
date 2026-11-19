import {
  extractJsonText,
  parseClassificationOutput,
  truncateReasoning,
} from './classifier-output.js';

const valid = {
  reasoning: 'Customer asks for the price.',
  category: 'SAFE_INQUIRY',
  confidence_score: 0.92,
  language: 'banglish',
};

const parse = (value: unknown) =>
  parseClassificationOutput(
    typeof value === 'string' ? value : JSON.stringify(value),
  );

describe('parseClassificationOutput', () => {
  it('accepts a valid answer', () => {
    expect(parse(valid)).toEqual({
      ok: true,
      value: {
        category: 'SAFE_INQUIRY',
        confidence: 0.92,
        reasoning: 'Customer asks for the price.',
        language: 'banglish',
      },
    });
  });

  it('accepts `confidence` as an alias and numeric strings', () => {
    const { confidence_score: _ignored, ...rest } = valid;
    expect(parse({ ...rest, confidence: 0.81 })).toMatchObject({
      ok: true,
      value: { confidence: 0.81 },
    });
    expect(parse({ ...valid, confidence_score: '0.7' })).toMatchObject({
      ok: true,
      value: { confidence: 0.7 },
    });
  });

  it('prefers confidence_score over confidence', () => {
    expect(
      parse({ ...valid, confidence_score: 0.6, confidence: 0.9 }),
    ).toMatchObject({ value: { confidence: 0.6 } });
  });

  it('clamps tiny overshoots, rounds to 3 decimals, rejects out of range', () => {
    expect(parse({ ...valid, confidence_score: 1.02 })).toMatchObject({
      value: { confidence: 1 },
    });
    expect(parse({ ...valid, confidence_score: -0.01 })).toMatchObject({
      value: { confidence: 0 },
    });
    expect(parse({ ...valid, confidence_score: 0.12345 })).toMatchObject({
      value: { confidence: 0.123 },
    });
    for (const bad of [85, -1, 1.5, 'high', null, Number.NaN]) {
      expect(parse({ ...valid, confidence_score: bad })).toEqual({
        ok: false,
        rejection: 'confidence',
      });
    }
    const { confidence_score: _ignored, ...missing } = valid;
    expect(parse(missing)).toEqual({ ok: false, rejection: 'confidence' });
  });

  it('accepts a case-insensitive category, rejects unknown ones', () => {
    expect(parse({ ...valid, category: ' scam_phishing ' })).toMatchObject({
      value: { category: 'SCAM_PHISHING' },
    });
    for (const bad of ['SAFE', 'HATE', 3, undefined]) {
      expect(parse({ ...valid, category: bad })).toEqual({
        ok: false,
        rejection: 'category',
      });
    }
  });

  it('maps language aliases, rejects others', () => {
    expect(parse({ ...valid, language: 'Bangla' })).toMatchObject({
      value: { language: 'bn' },
    });
    expect(parse({ ...valid, language: 'EN' })).toMatchObject({
      value: { language: 'en' },
    });
    for (const bad of ['hindi', 'constructor', '', 1]) {
      expect(parse({ ...valid, language: bad })).toEqual({
        ok: false,
        rejection: 'language',
      });
    }
  });

  it('requires a reasoning string, collapses and truncates it to 280', () => {
    expect(parse({ ...valid, reasoning: 5 })).toEqual({
      ok: false,
      rejection: 'reasoning',
    });
    const long = parse({ ...valid, reasoning: `a\n\nb ${'x'.repeat(400)}` });
    expect(long.ok && long.value.reasoning).toHaveLength(280);
    expect(long.ok && long.value.reasoning.startsWith('a b x')).toBe(true);
    expect(long.ok && long.value.reasoning.endsWith('…')).toBe(true);
  });

  it('drops unknown keys', () => {
    const result = parse({ ...valid, raw: 'secret', author: 'x' });
    expect(result.ok && Object.keys(result.value).sort()).toEqual([
      'category',
      'confidence',
      'language',
      'reasoning',
    ]);
  });

  it('strips code fences and surrounding prose', () => {
    const json = JSON.stringify(valid);
    expect(parse(`\`\`\`json\n${json}\n\`\`\``)).toMatchObject({ ok: true });
    expect(parse(`\`\`\`\n${json}\n\`\`\``)).toMatchObject({ ok: true });
    expect(parse(`Here is the answer: ${json} Thanks`)).toMatchObject({
      ok: true,
    });
  });

  it('rejects non-JSON and non-object answers', () => {
    expect(parse('SAFE_INQUIRY')).toEqual({ ok: false, rejection: 'not_json' });
    expect(parse('{"category": "SAFE_INQUIRY",')).toEqual({
      ok: false,
      rejection: 'not_json',
    });
    expect(parse('[1, 2]')).toEqual({ ok: false, rejection: 'not_object' });
    expect(parse('null')).toEqual({ ok: false, rejection: 'not_object' });
  });
});

describe('helpers', () => {
  it('extractJsonText leaves plain JSON alone', () => {
    expect(extractJsonText(' {"a":1} ')).toBe('{"a":1}');
  });

  it('truncateReasoning keeps short text', () => {
    expect(truncateReasoning('  Short   reason. ')).toBe('Short reason.');
  });
});
