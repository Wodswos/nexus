import { expect, it } from 'vitest';
import { reviewDayEnd, reviewDayStart } from '../src/reviewZone';
it('interprets review dates in the caller timezone, including 23/25-hour DST days', () => {
  expect(new Date(reviewDayStart('2026-11-04', 'Asia/Shanghai')).toISOString()).toBe('2026-11-03T16:00:00.000Z');
  expect(new Date(reviewDayStart('2026-11-04', 'UTC')).toISOString()).toBe('2026-11-04T00:00:00.000Z');
  expect(reviewDayStart('2026-03-09', 'America/New_York') - reviewDayStart('2026-03-08', 'America/New_York')).toBe(23 * 3600000);
  expect(reviewDayStart('2026-11-02', 'America/New_York') - reviewDayStart('2026-11-01', 'America/New_York')).toBe(25 * 3600000);
  expect(() => reviewDayStart('2026-11-04', 'not/a-zone')).toThrow();
  expect(() => reviewDayStart('2011-12-30', 'Pacific/Apia')).toThrow();
});
it('caps unfinished weekly work at the end of the caller day across timezone and DST boundaries', () => {
  expect(new Date(reviewDayEnd(Date.parse('2026-11-17T16:30:00Z'), 'Asia/Shanghai')).toISOString()).toBe('2026-11-18T16:00:00.000Z');
  expect(reviewDayEnd(reviewDayStart('2026-03-08', 'America/New_York'), 'America/New_York')).toBe(reviewDayStart('2026-03-09', 'America/New_York'));
  expect(reviewDayEnd(reviewDayStart('2026-11-01', 'America/New_York'), 'America/New_York')).toBe(reviewDayStart('2026-11-02', 'America/New_York'));
  expect(reviewDayEnd(reviewDayStart('2011-12-29', 'Pacific/Apia'), 'Pacific/Apia')).toBe(reviewDayStart('2011-12-31', 'Pacific/Apia'));
});
