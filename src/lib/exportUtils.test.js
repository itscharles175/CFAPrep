import { describe, expect, it } from 'vitest';
import { rowsToCsv } from './exportUtils';

describe('export utils', () => {
  it('serializes rows to escaped CSV', () => {
    expect(rowsToCsv([
      ['field', 'value'],
      ['quote', 'A "quoted" value'],
      ['blank', null],
    ])).toBe('"field","value"\n"quote","A ""quoted"" value"\n"blank",""');
  });
});
