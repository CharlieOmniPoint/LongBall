import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_STATUS_REQUEST } from './review-entry.mjs';

const canonical = 'https://raw.githubusercontent.com/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json';

test('discovery harness routes only the pinned endpoint with its bounded public cache key', () => {
  assert(REVIEW_STATUS_REQUEST.test(`${canonical}?reviewCheck=1792612578804-1`));
  assert(REVIEW_STATUS_REQUEST.test(`${canonical}?reviewCheck=9007199254740991-999999999`));
  for (const url of [
    canonical,
    `${canonical}?token=not-allowed`,
    `${canonical}?reviewCheck=1-1&token=not-allowed`,
    `${canonical}?reviewCheck=1-1&reviewCheck=2-2`,
    `${canonical}?reviewCheck=-1-1`,
    `${canonical}?reviewCheck=NaN-1`,
    `${canonical}?reviewCheck=10000000000000000-1`,
    `${canonical}?reviewCheck=1-1000000000`,
    `${canonical}?reviewCheck=1-1#fragment`,
    canonical.replace('raw.githubusercontent.com', 'other.example') + '?reviewCheck=1-1',
    canonical.replace('/preview-status.json', '/another.json') + '?reviewCheck=1-1',
    canonical.replace('https://', 'https://name:private@') + '?reviewCheck=1-1',
    `${canonical}?reviewCheck=1-1\n`,
  ]) assert.equal(REVIEW_STATUS_REQUEST.test(url), false, 'Only the exact pinned bounded discovery request is intercepted.');
});
