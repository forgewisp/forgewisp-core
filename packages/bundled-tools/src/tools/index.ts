// To add a new tool: create `src/tools/<tool-name>.ts` exporting a `FunctionDefinition`,
// add its named re-export below, then append it to the `BUNDLED_TOOLS` array in `src/index.ts`.

export { getCurrentTime } from './get-current-time.js';
export type { GetCurrentTimeArgs, GetCurrentTimeResult } from './get-current-time.js';

export { generateUuid } from './generate-uuid.js';
export type { GenerateUuidArgs, GenerateUuidResult } from './generate-uuid.js';

export { evaluateMath } from './evaluate-math.js';
export type { EvaluateMathArgs, EvaluateMathResult } from './evaluate-math.js';

export { hashText } from './hash-text.js';
export type { HashTextArgs, HashTextResult } from './hash-text.js';

export { encodeBase64 } from './encode-base64.js';
export type { EncodeBase64Args, EncodeBase64Result } from './encode-base64.js';

export { decodeBase64 } from './decode-base64.js';
export type { DecodeBase64Args, DecodeBase64Result } from './decode-base64.js';

export { getViewportInfo } from './get-viewport-info.js';
export type { GetViewportInfoArgs, GetViewportInfoResult } from './get-viewport-info.js';

export { getBatteryInfo } from './get-battery-info.js';
export type { GetBatteryInfoArgs, GetBatteryInfoResult } from './get-battery-info.js';

export { listLocalStorageKeys } from './list-local-storage-keys.js';
export type {
  ListLocalStorageKeysArgs,
  ListLocalStorageKeysResult,
} from './list-local-storage-keys.js';

export { getLocalStorageItem } from './get-local-storage-item.js';
export type {
  GetLocalStorageItemArgs,
  GetLocalStorageItemResult,
} from './get-local-storage-item.js';

export { copyToClipboard } from './copy-to-clipboard.js';
export type { CopyToClipboardArgs, CopyToClipboardResult } from './copy-to-clipboard.js';

export { speakText } from './speak-text.js';
export type { SpeakTextArgs, SpeakTextResult } from './speak-text.js';

export { downloadFile } from './download-file.js';
export type { DownloadFileArgs, DownloadFileResult } from './download-file.js';

export { setLocalStorageItem } from './set-local-storage-item.js';
export type {
  SetLocalStorageItemArgs,
  SetLocalStorageItemResult,
} from './set-local-storage-item.js';

export { getGeolocation } from './get-geolocation.js';
export type { GetGeolocationArgs, GetGeolocationResult } from './get-geolocation.js';

export { removeLocalStorageItem } from './remove-local-storage-item.js';
export type {
  RemoveLocalStorageItemArgs,
  RemoveLocalStorageItemResult,
} from './remove-local-storage-item.js';
