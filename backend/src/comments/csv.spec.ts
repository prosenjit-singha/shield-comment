import { csvCell, toCsv } from './csv.js';

describe('CSV builder (M6-T6, D12)', () => {
  it('starts with a UTF-8 BOM, keeps the header order and ends rows with CRLF', () => {
    const csv = toCsv(
      ['day', 'page_name', 'received'],
      [
        ['2026-11-20', 'Shop A', 3],
        ['2026-11-21', null, 0],
      ],
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe(
      'day,page_name,received\r\n2026-11-20,Shop A,3\r\n2026-11-21,,0\r\n',
    );
    expect(Buffer.from(csv, 'utf8').subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
  });

  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('cr\r\nlf')).toBe('"cr\r\nlf"');
    expect(csvCell('plain')).toBe('plain');
  });

  it('keeps Bangla text as is', () => {
    const csv = toCsv(['text'], [['দাম কত? বিকাশে পাঠান']]);
    expect(csv).toBe('﻿text\r\nদাম কত? বিকাশে পাঠান\r\n');
    expect(Buffer.from(csv, 'utf8').toString('utf8')).toBe(csv);
  });

  it.each([
    ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
    ['+8801712345678', "'+8801712345678"],
    ['-1+2', "'-1+2"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
  ])('guards formula-looking text %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('writes numbers raw and leaves inner signs alone', () => {
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(0.912)).toBe('0.912');
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell(undefined)).toBe('');
  });
});
