import {
  redactQueryObject,
  redactRequestSerializer,
  redactUrlQuery,
} from './redact-query.js';

describe('redact-query', () => {
  it('redacts code and state in a callback URL, keeps the rest', () => {
    expect(
      redactUrlQuery(
        '/api/meta/oauth/callback?code=AQDsecret&state=abc123&error_reason=x',
      ),
    ).toBe(
      '/api/meta/oauth/callback?code=%5BRedacted%5D&state=%5BRedacted%5D&error_reason=x',
    );
  });

  it('redacts repeated and differently-cased keys', () => {
    const out = redactUrlQuery('/x?Code=a&code=b&ACCESS_TOKEN=EAAtoken');
    expect(out).not.toMatch(/=a\b|=b\b|EAAtoken/);
  });

  it('leaves URLs without sensitive params untouched', () => {
    expect(redactUrlQuery('/api/health')).toBe('/api/health');
    expect(redactUrlQuery('/api/x?returnTo=%2Fpages')).toBe(
      '/api/x?returnTo=%2Fpages',
    );
  });

  it('copies query objects without mutating them', () => {
    const query = { code: 'AQD', state: 's', returnTo: '/pages' };
    expect(redactQueryObject(query)).toEqual({
      code: '[Redacted]',
      state: '[Redacted]',
      returnTo: '/pages',
    });
    expect(query.code).toBe('AQD');
    expect(redactQueryObject(undefined)).toBeUndefined();
  });

  it('serializer redacts url and query of the serialized request', () => {
    const req = {
      method: 'GET',
      url: '/api/meta/oauth/callback?code=AQD&state=s',
      query: { code: 'AQD', state: 's' },
    };
    const out = redactRequestSerializer(req);
    expect(JSON.stringify(out)).not.toMatch(/AQD|=s\b|"s"/);
    expect(out.method).toBe('GET');
  });
});
