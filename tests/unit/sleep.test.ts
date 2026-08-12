import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSleepMessage } from '../../src/health/sleep.ts';

describe('sleep reporting', () => {
  it('reports only the authoritative native-helper boundary', () => {
    const message = renderSleepMessage();

    assert.match(message, /🟡/);
    assert.match(message, /переход в сон/i);
    assert.match(message, /новый поток/i);
    assert.match(message, /точная длительность сна не определяется/i);
    assert.doesNotMatch(message, /\d+\s*(?:мин|ч)/i);
  });
});
