// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { speakText } from '../src/tools/speak-text.js';
import type { SpeakTextResult } from '../src/tools/speak-text.js';

// jsdom does not implement speechSynthesis, so we provide a minimal fake.
class FakeUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  volume = 1;
  lang = '';
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

describe('speakText', () => {
  let speak: Mock<[FakeUtterance], void>;
  let cancel: Mock<[], void>;
  let utterance: FakeUtterance;

  beforeEach(() => {
    speak = vi.fn<[FakeUtterance], void>((u: FakeUtterance) => {
      utterance = u;
    });
    cancel = vi.fn<[], void>();
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak, cancel },
      configurable: true,
    });
    (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = FakeUtterance;
  });

  afterEach(() => {
    delete (window as { speechSynthesis?: unknown }).speechSynthesis;
    delete (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    vi.useRealTimers();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(speakText.name).toBe('speakText');
    expect(speakText.riskTier).toBe('write');
    expect(speakText.parameters.required).toEqual(['text']);
    expect(speakText.parameters.additionalProperties).toBe(false);
  });

  it('speaks text and resolves on onend', async () => {
    const promise = speakText.handler({ text: 'hi' }) as Promise<SpeakTextResult>;
    expect(speak).toHaveBeenCalledTimes(1);
    expect(utterance.text).toBe('hi');
    utterance.onend!();
    await expect(promise).resolves.toEqual({ spoken: true, utteranceLength: 2 });
  });

  it('rejects on onerror', async () => {
    const promise = speakText.handler({ text: 'hi' });
    utterance.onerror!({ error: 'audio-busy' });
    await expect(promise).rejects.toThrow(/Speech synthesis failed/);
  });

  it('times out if onend never fires', async () => {
    vi.useFakeTimers();
    const promise = speakText.handler({ text: 'hi' });
    // The handler uses a 30s timeout; advance past it.
    vi.advanceTimersByTime(31_000);
    await expect(promise).rejects.toThrow(/timed out/);
    expect(cancel).toHaveBeenCalled();
  });

  it('throws when speechSynthesis is unavailable', async () => {
    delete (window as { speechSynthesis?: unknown }).speechSynthesis;
    await expect(speakText.handler({ text: 'hi' })).rejects.toThrow(
      /speechSynthesis is unavailable/,
    );
  });
});
