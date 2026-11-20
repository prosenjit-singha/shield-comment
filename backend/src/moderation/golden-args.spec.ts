import {
  GOLDEN_USAGE,
  parseGoldenArgs,
  selectGoldenItems,
} from './golden-args.js';
import type { GoldenComment } from './golden-fixture.js';

describe('parseGoldenArgs', () => {
  it('defaults to the active provider, comment_only, no record, all items', () => {
    expect(parseGoldenArgs([])).toEqual({
      contextLevel: 'comment_only',
      record: false,
      help: false,
    });
  });

  it('parses every flag, in both --flag value and --flag=value forms', () => {
    expect(
      parseGoldenArgs([
        '--provider',
        'anthropic',
        '--model=claude-haiku-4-5',
        '--level',
        'post_caption',
        '--limit=5',
      ]),
    ).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      contextLevel: 'post_caption',
      limit: 5,
      record: false,
      help: false,
    });
    expect(parseGoldenArgs(['--record', '--level=page_name'])).toMatchObject({
      record: true,
      contextLevel: 'page_name',
    });
    expect(parseGoldenArgs(['--help']).help).toBe(true);
    expect(parseGoldenArgs(['-h']).help).toBe(true);
  });

  it.each([
    [
      ['--provider', 'mistral'],
      /--provider must be one of neon, openai, anthropic, google/,
    ],
    [['--provider'], /--provider needs a value/],
    [['--model', '--record'], /--model needs a value/],
    [['--model='], /--model needs a value/],
    [['--model', ' '], /--model must be 1–200/],
    [
      ['--level', 'full'],
      /--level must be one of comment_only, page_name, post_caption/,
    ],
    [['--limit', '0'], /--limit must be a whole number/],
    [['--limit', '2.5'], /--limit must be a whole number/],
    [['--limit', 'abc'], /--limit must be a whole number/],
    [['--record=yes'], /--record takes no value/],
    [['--verbose'], /unknown option --verbose/],
    [['openai'], /unknown option openai/],
    [['--level', 'page_name', '--level=comment_only'], /--level given twice/],
    [['--record', '--limit', '3'], /--record needs the whole fixture/],
    [['--language', 'hindi'], /--language must be one of bn, banglish, en/],
    [['--language'], /--language needs a value/],
    [['--language', 'bn', '--language=en'], /--language given twice/],
    [['--language=bn', '--record'], /--record needs the whole fixture/],
  ])('rejects %j', (argv, error) => {
    expect(() => parseGoldenArgs(argv)).toThrow(error);
  });

  it('documents every flag in the usage text', () => {
    for (const flag of [
      '--provider',
      '--model',
      '--level',
      '--limit',
      '--language',
      '--record',
      '--help',
    ]) {
      expect(GOLDEN_USAGE).toContain(flag);
    }
  });

  it('parses --language in both forms and combines it with --limit', () => {
    expect(parseGoldenArgs(['--language', 'bn']).language).toBe('bn');
    expect(parseGoldenArgs(['--language=en']).language).toBe('en');
    expect(
      parseGoldenArgs(['--language', 'banglish', '--limit=5']),
    ).toMatchObject({ language: 'banglish', limit: 5 });
  });
});

describe('selectGoldenItems', () => {
  const item = (id: string, language: GoldenComment['language']) =>
    ({ id, language }) as GoldenComment;
  const fixture = [
    item('scam-01', 'bn'),
    item('scam-02', 'en'),
    item('spam-01', 'bn'),
    item('safe-01', 'banglish'),
    item('abuse-01', 'bn'),
  ];

  it('keeps every item without filters', () => {
    expect(selectGoldenItems(fixture, {})).toEqual(fixture);
  });

  it('filters by language before the limit, in fixture order', () => {
    const ids = (items: GoldenComment[]) => items.map((i) => i.id);
    expect(ids(selectGoldenItems(fixture, { language: 'bn' }))).toEqual([
      'scam-01',
      'spam-01',
      'abuse-01',
    ]);
    expect(
      ids(selectGoldenItems(fixture, { language: 'bn', limit: 2 })),
    ).toEqual(['scam-01', 'spam-01']);
    expect(ids(selectGoldenItems(fixture, { limit: 2 }))).toEqual([
      'scam-01',
      'scam-02',
    ]);
  });
});
