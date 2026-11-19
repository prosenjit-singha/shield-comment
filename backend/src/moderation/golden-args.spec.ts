import { GOLDEN_USAGE, parseGoldenArgs } from './golden-args.js';

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
  ])('rejects %j', (argv, error) => {
    expect(() => parseGoldenArgs(argv)).toThrow(error);
  });

  it('documents every flag in the usage text', () => {
    for (const flag of [
      '--provider',
      '--model',
      '--level',
      '--limit',
      '--record',
      '--help',
    ]) {
      expect(GOLDEN_USAGE).toContain(flag);
    }
  });
});
