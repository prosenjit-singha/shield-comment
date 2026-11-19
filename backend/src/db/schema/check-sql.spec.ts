import {
  allOrNoneSql,
  inListSql,
  lengthSql,
  nonNegativeSql,
  patternSql,
  quoted,
  snakeCase,
} from './check-sql.js';

describe('check-sql builders (M5-T7)', () => {
  it('quoted: SQL literals, single quotes doubled, empty list refused', () => {
    expect(quoted(['A', 'B'])).toBe(`'A', 'B'`);
    expect(quoted(["it's"])).toBe(`'it''s'`);
    expect(() => quoted([])).toThrow();
  });

  it('inListSql: plain and nullable', () => {
    expect(inListSql('status', ['PENDING', 'HIDDEN'])).toBe(
      `status in ('PENDING', 'HIDDEN')`,
    );
    expect(inListSql('category', ['X'], true)).toBe(
      `category is null or category in ('X')`,
    );
  });

  it('lengthSql: range, nullable, bad bounds refused', () => {
    expect(lengthSql('model', 1, 100)).toBe(
      'char_length(model) between 1 and 100',
    );
    expect(lengthSql('reply_en', 1, 500, true)).toBe(
      'reply_en is null or char_length(reply_en) between 1 and 500',
    );
    expect(() => lengthSql('x', 5, 1)).toThrow();
    expect(() => lengthSql('x', -1, 1)).toThrow();
    expect(() => lengthSql('x', 0.5, 1)).toThrow();
  });

  it('patternSql: regex literal escaped, nullable', () => {
    expect(patternSql('code', '^[a-z]+$')).toBe(`code ~ '^[a-z]+$'`);
    expect(patternSql('code', "^a'b$", true)).toBe(
      `code is null or code ~ '^a''b$'`,
    );
  });

  it('nonNegativeSql / allOrNoneSql need columns', () => {
    expect(nonNegativeSql(['a', 'b'])).toBe('a >= 0 and b >= 0');
    expect(() => nonNegativeSql([])).toThrow();
    expect(allOrNoneSql(['a', 'b'])).toBe(
      '(a is null and b is null) or (a is not null and b is not null)',
    );
    expect(() => allOrNoneSql(['a'])).toThrow();
  });

  it('snakeCase matches the casing rule', () => {
    expect(snakeCase('safeInquiryAutoReply')).toBe('safe_inquiry_auto_reply');
    expect(snakeCase('receivedCount')).toBe('received_count');
    expect(snakeCase('calls')).toBe('calls');
  });
});
