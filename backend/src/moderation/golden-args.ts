import {
  AI_PROVIDERS,
  type AiProvider,
  isAiProvider,
} from '../ai-gateway/ai-provider.js';
import {
  CONTEXT_LEVELS,
  type ContextLevel,
  DEFAULT_CONTEXT_LEVEL,
  isContextLevel,
} from './moderation.constants.js';

/** Flags of `npm run ai:golden -- …` (M5-T6). Pure: the script prints `GOLDEN_USAGE` on error. */
export interface GoldenArgs {
  /** Overrides the active provider (its key/model still come from DB settings → `.env`). */
  provider?: AiProvider;
  /** Overrides the provider's model. */
  model?: string;
  contextLevel: ContextLevel;
  /** Write `test/fixtures/golden-responses.<provider>.<model>.json` from this run. */
  record: boolean;
  /** Only the first N fixture items (quick smoke; not with `--record`). */
  limit?: number;
  help: boolean;
}

export const GOLDEN_USAGE = `Usage: npm run ai:golden -- [options]   (run npm run build first)
  --provider <${AI_PROVIDERS.join('|')}>   provider to test (default: the active one, DB settings → .env)
  --model <id>                         model id (default: that provider's configured model)
  --level <${CONTEXT_LEVELS.join('|')}>   data sent per comment (default ${DEFAULT_CONTEXT_LEVEL})
  --limit <n>                          only the first n fixture comments (not with --record)
  --record                             write test/fixtures/golden-responses.<provider>.<model>.json
  --help                               show this help
Live calls cost money. Exit 1 below 90 % accuracy or when the provider is not usable.`;

export class GoldenArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenArgsError';
  }
}

/** Parses `process.argv.slice(2)`. Accepts `--flag value` and `--flag=value`. Throws `GoldenArgsError`. */
export function parseGoldenArgs(argv: readonly string[]): GoldenArgs {
  const args: GoldenArgs = {
    contextLevel: DEFAULT_CONTEXT_LEVEL,
    record: false,
    help: false,
  };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    if (seen.has(flag)) throw new GoldenArgsError(`${flag} given twice`);
    seen.add(flag);
    const value = (): string => {
      if (inline !== undefined) {
        if (inline.length === 0)
          throw new GoldenArgsError(`${flag} needs a value`);
        return inline;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new GoldenArgsError(`${flag} needs a value`);
      }
      i += 1;
      return next;
    };
    const noValue = () => {
      if (inline !== undefined) {
        throw new GoldenArgsError(`${flag} takes no value`);
      }
    };
    switch (flag) {
      case '--provider': {
        const provider = value();
        if (!isAiProvider(provider)) {
          throw new GoldenArgsError(
            `--provider must be one of ${AI_PROVIDERS.join(', ')}`,
          );
        }
        args.provider = provider;
        break;
      }
      case '--model': {
        const model = value().trim();
        if (model.length === 0 || model.length > 200) {
          throw new GoldenArgsError('--model must be 1–200 characters');
        }
        args.model = model;
        break;
      }
      case '--level': {
        const level = value();
        if (!isContextLevel(level)) {
          throw new GoldenArgsError(
            `--level must be one of ${CONTEXT_LEVELS.join(', ')}`,
          );
        }
        args.contextLevel = level;
        break;
      }
      case '--limit': {
        const raw = value();
        const limit = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1) {
          throw new GoldenArgsError('--limit must be a whole number ≥ 1');
        }
        args.limit = limit;
        break;
      }
      case '--record':
        noValue();
        args.record = true;
        break;
      case '--help':
      case '-h':
        noValue();
        args.help = true;
        break;
      default:
        throw new GoldenArgsError(`unknown option ${token}`);
    }
  }
  if (args.record && args.limit !== undefined) {
    throw new GoldenArgsError(
      '--record needs the whole fixture: drop --limit (CI replays every item)',
    );
  }
  return args;
}
