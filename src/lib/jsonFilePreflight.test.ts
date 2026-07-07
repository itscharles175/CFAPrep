import { describe, expect, it } from 'vitest';

import { parseJsonFile } from './jsonFilePreflight';

describe('parseJsonFile', () => {
  it('parses JSON and reports byte size', async () => {
    const file = new File(['{"ok":true}'], 'payload.json', { type: 'application/json' });

    const result = await parseJsonFile(file, { maxBytes: 1024 });

    expect(result.payload).toEqual({ ok: true });
    expect(result.sizeBytes).toBe(file.size);
    expect(result.parsedInWorker).toBe(false);
  });

  it('rejects files over the configured byte cap before parsing', async () => {
    const file = new File(['{"too":"large"}'], 'large.json', { type: 'application/json' });

    await expect(parseJsonFile(file, { maxBytes: 4 })).rejects.toThrow(/import limit/i);
  });
});
