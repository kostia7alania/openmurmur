import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  asrRetryKeyboard,
  asrSettingsKeyboard,
  parseAsrModeCallback,
  parseAsrRetryCallback,
  renderAsrSettings,
} from '../../src/telegram/settings.ts';

describe('Telegram ASR settings', () => {
  it('uses explicit versioned radio actions that fit callback_data', () => {
    const keyboard = asrSettingsKeyboard('Thai');
    const buttons = keyboard.inline_keyboard.flat();
    assert.equal(buttons.length, 5);
    assert.ok(buttons.every((button) => Buffer.byteLength(button.callback_data) <= 64));
    assert.ok(
      buttons.find((button) => button.callback_data.endsWith(':th'))?.text.startsWith('✅'),
    );
    assert.ok(
      buttons.find((button) => button.callback_data.endsWith(':auto'))?.text.startsWith('○'),
    );
  });

  it('parses only supported settings and transcript actions', () => {
    assert.deepEqual(parseAsrModeCallback('asr-mode:v1:settings:auto'), {
      language: null,
      origin: 'settings',
    });
    assert.deepEqual(parseAsrModeCallback('asr-mode:v1:transcript:zh'), {
      language: 'zh',
      origin: 'transcript',
    });
    for (const invalid of [undefined, 'asr-mode:v1:settings:de', 'asr-mode:v2:settings:th']) {
      assert.equal(parseAsrModeCallback(invalid), undefined);
    }
  });

  it('uses bounded per-file retry actions for incoming transcripts', () => {
    const fileUid = '123e4567-e89b-42d3-a456-426614174000';
    const keyboard = asrRetryKeyboard(fileUid, null);
    const buttons = keyboard.inline_keyboard.flat();
    assert.equal(buttons.length, 4);
    assert.ok(buttons.every((button) => Buffer.byteLength(button.callback_data) <= 64));
    assert.deepEqual(parseAsrRetryCallback(`asr-retry:v1:auto:${fileUid}`), {
      language: null,
      fileUid,
    });
    assert.deepEqual(parseAsrRetryCallback(`asr-retry:v1:ru:${fileUid}`), {
      language: 'ru',
      fileUid,
    });
    assert.equal(parseAsrRetryCallback('asr-retry:v1:de:123'), undefined);
  });

  it('makes host scope and future-only behavior explicit', () => {
    const text = renderAsrSettings('dev <Mac>', null);
    assert.match(text, /dev &lt;Mac&gt;/);
    assert.match(text, /автоматически/);
    assert.match(text, /следующим расшифровкам/);
  });
});
