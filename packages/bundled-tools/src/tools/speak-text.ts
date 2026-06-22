import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface SpeakTextArgs {
  /** Text to speak aloud. */
  text: string;
  /** Speak rate, 0.1–10. Defaults to the engine default (1). */
  rate?: number;
  /** Speak pitch, 0–2. Defaults to the engine default (1). */
  pitch?: number;
  /** Speak volume, 0–1. Defaults to the engine default (1). */
  volume?: number;
  /** BCP-47 language tag, e.g. "en-US". */
  lang?: string;
}

export interface SpeakTextResult {
  spoken: true;
  /** Number of characters spoken. */
  utteranceLength: number;
  /** The language tag used, if one was provided. */
  lang?: string;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'Text to speak aloud.',
      minLength: 1,
      maxLength: 5000,
    },
    rate: { type: 'number', minimum: 0.1, maximum: 10, description: 'Speak rate (0.1–10).' },
    pitch: { type: 'number', minimum: 0, maximum: 2, description: 'Speak pitch (0–2).' },
    volume: { type: 'number', minimum: 0, maximum: 1, description: 'Speak volume (0–1).' },
    lang: {
      type: 'string',
      minLength: 2,
      maxLength: 35,
      description: 'BCP-47 language tag, e.g. "en-US".',
    },
  },
  required: ['text'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

const SPEECH_TIMEOUT_MS = 30_000;

export const speakText: FunctionDefinition<SpeakTextArgs> = defineTool({
  name: 'speakText',
  description:
    "Speak text aloud using the browser's speech synthesis. May produce audible output. " +
    'Resolves when the utterance finishes; times out after 30 seconds.',
  riskTier: 'write',
  parameters,
  handler: (args: SpeakTextArgs): Promise<SpeakTextResult> => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return Promise.reject(new Error('speechSynthesis is unavailable in this environment.'));
    }
    const utterance = new SpeechSynthesisUtterance(args.text);
    if (args.rate !== undefined) utterance.rate = args.rate;
    if (args.pitch !== undefined) utterance.pitch = args.pitch;
    if (args.volume !== undefined) utterance.volume = args.volume;
    if (args.lang !== undefined) utterance.lang = args.lang;

    return new Promise<SpeakTextResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        window.speechSynthesis.cancel();
        reject(new Error('Speech synthesis timed out.'));
      }, SPEECH_TIMEOUT_MS);

      utterance.onend = () => {
        clearTimeout(timeoutId);
        resolve({
          spoken: true,
          utteranceLength: args.text.length,
          ...(args.lang !== undefined ? { lang: args.lang } : {}),
        });
      };
      utterance.onerror = (event) => {
        clearTimeout(timeoutId);
        reject(
          new Error(
            'Speech synthesis failed: ' +
              ('error' in event && typeof event.error === 'string' ? event.error : 'unknown error'),
          ),
        );
      };

      window.speechSynthesis.speak(utterance);
    });
  },
});
