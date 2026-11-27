import { afterEach, expect, it, vi } from 'vitest';
import { newUuid } from '../src/id';

afterEach(() => vi.unstubAllGlobals());

it('generates UUID v4 using Web Crypto when randomUUID is unavailable on HTTP', () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal('crypto', { getRandomValues });
  const values = Array.from({ length: 100 }, () => newUuid());
  for (const value of values) expect(value).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(new Set(values).size).toBe(values.length);
});
