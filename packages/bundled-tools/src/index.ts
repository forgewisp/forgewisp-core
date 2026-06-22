// Re-export the core types this package is built around so consumers can import
// everything they need from one place. Type-only re-exports don't affect treeshaking.
export type { FunctionDefinition, RiskTier, JSONSchema, JSONSchemaProperty } from '@forgewisp/core';

export { defineTool } from './define-tool.js';

export { getCurrentTime } from './tools/index.js';
export type { GetCurrentTimeArgs, GetCurrentTimeResult } from './tools/index.js';

export { generateUuid } from './tools/index.js';
export type { GenerateUuidArgs, GenerateUuidResult } from './tools/index.js';

export { evaluateMath } from './tools/index.js';
export type { EvaluateMathArgs, EvaluateMathResult } from './tools/index.js';

export { hashText } from './tools/index.js';
export type { HashTextArgs, HashTextResult } from './tools/index.js';

export { encodeBase64 } from './tools/index.js';
export type { EncodeBase64Args, EncodeBase64Result } from './tools/index.js';

export { decodeBase64 } from './tools/index.js';
export type { DecodeBase64Args, DecodeBase64Result } from './tools/index.js';

export { getViewportInfo } from './tools/index.js';
export type { GetViewportInfoArgs, GetViewportInfoResult } from './tools/index.js';

export { getBatteryInfo } from './tools/index.js';
export type { GetBatteryInfoArgs, GetBatteryInfoResult } from './tools/index.js';

export { listLocalStorageKeys } from './tools/index.js';
export type { ListLocalStorageKeysArgs, ListLocalStorageKeysResult } from './tools/index.js';

export { getLocalStorageItem } from './tools/index.js';
export type { GetLocalStorageItemArgs, GetLocalStorageItemResult } from './tools/index.js';

export { copyToClipboard } from './tools/index.js';
export type { CopyToClipboardArgs, CopyToClipboardResult } from './tools/index.js';

export { speakText } from './tools/index.js';
export type { SpeakTextArgs, SpeakTextResult } from './tools/index.js';

export { downloadFile } from './tools/index.js';
export type { DownloadFileArgs, DownloadFileResult } from './tools/index.js';

export { setLocalStorageItem } from './tools/index.js';
export type { SetLocalStorageItemArgs, SetLocalStorageItemResult } from './tools/index.js';

export { getGeolocation } from './tools/index.js';
export type { GetGeolocationArgs, GetGeolocationResult } from './tools/index.js';

export { removeLocalStorageItem } from './tools/index.js';
export type { RemoveLocalStorageItemArgs, RemoveLocalStorageItemResult } from './tools/index.js';

import { getCurrentTime } from './tools/index.js';
import { generateUuid } from './tools/index.js';
import { evaluateMath } from './tools/index.js';
import { hashText } from './tools/index.js';
import { encodeBase64 } from './tools/index.js';
import { decodeBase64 } from './tools/index.js';
import { getViewportInfo } from './tools/index.js';
import { getBatteryInfo } from './tools/index.js';
import { listLocalStorageKeys } from './tools/index.js';
import { getLocalStorageItem } from './tools/index.js';
import { copyToClipboard } from './tools/index.js';
import { speakText } from './tools/index.js';
import { downloadFile } from './tools/index.js';
import { setLocalStorageItem } from './tools/index.js';
import { getGeolocation } from './tools/index.js';
import { removeLocalStorageItem } from './tools/index.js';

/**
 * Every bundled tool, ready to register. Use:
 *
 *   import { createAgent } from '@forgewisp/core';
 *   import { BUNDLED_TOOLS } from '@forgewisp/bundled-tools';
 *   const agent = createAgent(config);
 *   BUNDLED_TOOLS.forEach((def) => agent.registerFunction(def));
 *
 * Append new tools here as they are added under `src/tools/`. Grouped by tier
 * (read → write → destructive) for stable ordering.
 */
export const BUNDLED_TOOLS = [
  // read
  getCurrentTime,
  generateUuid,
  evaluateMath,
  hashText,
  encodeBase64,
  decodeBase64,
  getViewportInfo,
  getBatteryInfo,
  listLocalStorageKeys,
  getLocalStorageItem,
  // write
  copyToClipboard,
  speakText,
  downloadFile,
  setLocalStorageItem,
  getGeolocation,
  // destructive
  removeLocalStorageItem,
] as const;
