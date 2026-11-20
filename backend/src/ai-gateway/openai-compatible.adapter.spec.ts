import { AiGatewayError } from './ai-gateway.errors.js';
import {
  chatCompletionsBody,
  chatCompletionsUrl,
  extractText,
  parseChatCompletion,
} from './openai-compatible.adapter.js';

describe('chatCompletionsUrl', () => {
  it.each([
    [
      'neon',
      'https://br-x-api.ai.aws.neon.tech',
      'https://br-x-api.ai.aws.neon.tech/v1/chat/completions',
    ],
    [
      'neon',
      'https://br-x-api.ai.aws.neon.tech//',
      'https://br-x-api.ai.aws.neon.tech/v1/chat/completions',
    ],
    [
      'neon',
      'https://br-x-api.ai.aws.neon.tech/v1/',
      'https://br-x-api.ai.aws.neon.tech/v1/chat/completions',
    ],
    [
      'openai',
      'https://api.openai.com/v1',
      'https://api.openai.com/v1/chat/completions',
    ],
    [
      'openai',
      'https://api.openai.com/v1/',
      'https://api.openai.com/v1/chat/completions',
    ],
    [
      'google',
      'https://generativelanguage.googleapis.com/v1beta/openai/',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ],
  ] as const)('%s %s', (provider, base, url) => {
    expect(chatCompletionsUrl(provider, base)).toBe(url);
  });
});

describe('chatCompletionsBody', () => {
  const messages = [
    { role: 'system' as const, content: 'classify' },
    { role: 'user' as const, content: 'price koto?' },
  ];
  const schema = {
    type: 'object',
    properties: { category: { type: 'string' } },
    required: ['category'],
    additionalProperties: false,
  };

  it('sends only model + messages by default', () => {
    expect(
      chatCompletionsBody('neon', { model: 'gpt-oss-20b', messages }),
    ).toEqual({
      model: 'gpt-oss-20b',
      messages,
    });
  });

  it('maps json_schema, max_tokens and temperature (Neon / Google)', () => {
    for (const provider of ['neon', 'google'] as const) {
      expect(
        chatCompletionsBody(provider, {
          model: 'm',
          messages,
          maxTokens: 200,
          temperature: 0,
          responseFormat: {
            type: 'json_schema',
            name: 'moderation',
            schema,
            strict: true,
          },
        }),
      ).toEqual({
        model: 'm',
        messages,
        max_tokens: 200,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'moderation', schema, strict: true },
        },
      });
    }
  });

  it('leaves temperature out for Neon models whose catalog entry has no temperature', () => {
    for (const model of ['gemini-4-carbon', 'claude-haiku-5-5']) {
      expect(
        chatCompletionsBody('neon', { model, messages, temperature: 0 }),
      ).toEqual({ model, messages });
    }
    expect(
      chatCompletionsBody('neon', {
        model: 'gpt-oss-20b',
        messages,
        temperature: 0,
      }),
    ).toEqual({ model: 'gpt-oss-20b', messages, temperature: 0 });
    // The catalog is Neon's: other providers keep it.
    expect(
      chatCompletionsBody('google', {
        model: 'gemini-4-carbon',
        messages,
        temperature: 0,
      }),
    ).toEqual({ model: 'gemini-4-carbon', messages, temperature: 0 });
  });

  it('uses max_completion_tokens for OpenAI and maps json_object', () => {
    expect(
      chatCompletionsBody('openai', {
        model: 'gpt-4.1-mini',
        messages,
        maxTokens: 64,
        responseFormat: { type: 'json_object' },
      }),
    ).toEqual({
      model: 'gpt-4.1-mini',
      messages,
      max_completion_tokens: 64,
      response_format: { type: 'json_object' },
    });
  });

  it('omits strict when not given', () => {
    const body = chatCompletionsBody('neon', {
      model: 'm',
      messages,
      responseFormat: { type: 'json_schema', name: 'x', schema },
    });
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'x', schema },
    });
  });
});

describe('parseChatCompletion', () => {
  it('maps content, usage, model and finish reason', () => {
    expect(
      parseChatCompletion('neon', 'requested', {
        model: 'gpt-oss-20b-2026',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    ).toEqual({
      model: 'gpt-oss-20b-2026',
      content: 'ok',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      finishReason: 'stop',
    });
  });

  it('falls back to the requested model and leaves usage out when absent', () => {
    expect(
      parseChatCompletion('google', 'gemini-2.5-flash-lite', {
        choices: [{ message: { content: [{ type: 'text', text: 'hi' }] } }],
      }),
    ).toEqual({
      model: 'gemini-2.5-flash-lite',
      content: 'hi',
      usage: undefined,
      finishReason: undefined,
    });
  });

  it.each([
    ['non-JSON body', undefined],
    ['no choices', { choices: [] }],
    [
      'null content',
      { choices: [{ message: { content: null, refusal: 'no' } }] },
    ],
    ['blank content', { choices: [{ message: { content: '  ' } }] }],
    [
      'only reasoning parts',
      { choices: [{ message: { content: [{ type: 'reasoning' }] } }] },
    ],
  ])('%s → unexpected_response', (_label, body) => {
    let error: unknown;
    try {
      parseChatCompletion('neon', 'm', body);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AiGatewayError);
    expect(error).toMatchObject({
      kind: 'unexpected_response',
      status: 200,
      retryable: false,
    });
  });
});

describe('extractText', () => {
  it('handles string and multi-part content', () => {
    expect(extractText('hi')).toBe('hi');
    expect(
      extractText([
        { type: 'reasoning', summary: [] },
        { type: 'text', text: 'po' },
        { type: 'text', text: 'ng' },
      ]),
    ).toBe('pong');
    expect(extractText(null)).toBe('');
  });
});
