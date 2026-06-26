import type {
  OAuthClientProvider,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@forgewisp/mcp';

// ─── OAuth for the MCP demo ───────────────────────────────────────────────────
//
// A localStorage-backed `OAuthClientProvider` for a single MCP server. The SDK transport drives the
// real OAuth 2.1 flow (RFC 9728 / 8414 discovery, PKCE, token exchange, refresh) — this provider
// only owns the app-specific pieces: where to send the user back (a dedicated callback page),
// where to persist tokens / client info / the PKCE verifier, and how to open the authorization URL.
//
// Two redirect strategies, both landing on `/oauth-callback.html` (see `oauth-callback.html`):
//   - popup (default): `window.open(url)` keeps this tab alive so the in-memory `createMcpTools`
//     handle survives and `handle.finishAuth(code)` completes in place (via a `message` event).
//   - same-tab fallback (popup blocked): we record the URL for a manual link; navigating away loses
//     the in-memory handle, so the pending server config is persisted and the callback page redirects
//     back to `/?code&state`, where the app's load-resume path calls
//     `createMcpTools(config, { authorizationCode })` to finish in one shot.
//
// All storage is namespaced per server name so multiple servers can be authorized independently.

/** Persisted per-server OAuth state (tokens, registered client info, PKCE verifier, state). */
interface PersistedOAuthState {
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformationMixed;
  verifier?: string;
  state?: string;
}

/** Persisted pending-server config used by the same-tab resume path. */
export interface PendingServerConfig {
  name: string;
  url: string;
  defaultTier: 'read' | 'write' | 'destructive';
  hasConfirmation: boolean;
  requestTimeoutMs?: number;
  scope?: string;
}

const STORAGE_PREFIX = 'forgewisp.mcp.oauth.';
const PENDING_PREFIX = 'forgewisp.mcp.oauthPending.';
export const OAUTH_CALLBACK_PATH = '/oauth-callback.html';

function storageKey(serverName: string): string {
  return STORAGE_PREFIX + serverName;
}
function pendingKey(state: string): string {
  return PENDING_PREFIX + state;
}

function readState(serverName: string): PersistedOAuthState {
  const raw = localStorage.getItem(storageKey(serverName));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as PersistedOAuthState;
  } catch {
    return {};
  }
}
function writeState(serverName: string, state: PersistedOAuthState): void {
  localStorage.setItem(storageKey(serverName), JSON.stringify(state));
}

/** Generate a fresh PKCE code verifier (43–128 chars of the unreserved set, RFC 7636 §4.1). */
function randomVerifier(): string {
  const LEN = 48;
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const vals = new Uint32Array(LEN);
    crypto.getRandomValues(vals);
    let out = '';
    for (let i = 0; i < LEN; i++) out += CHARS[vals[i]! % CHARS.length];
    return out;
  }
  let out = '';
  for (let i = 0; i < LEN; i++) out += CHARS[Math.floor(Math.random() * CHARS.length)];
  return out;
}

/** Persist a pending server config keyed by OAuth `state`, for the same-tab resume path. */
export function storePendingServer(state: string, cfg: PendingServerConfig): void {
  localStorage.setItem(pendingKey(state), JSON.stringify(cfg));
}
/** Read (and leave in place) the pending server config for a given `state`. */
export function readPendingServer(state: string): PendingServerConfig | undefined {
  const raw = localStorage.getItem(pendingKey(state));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as PendingServerConfig;
  } catch {
    return undefined;
  }
}
/** Remove the pending server config for a `state` (call after a successful resume). */
export function clearPendingServer(state: string): void {
  localStorage.removeItem(pendingKey(state));
}

/**
 * Build a localStorage-backed `OAuthClientProvider` for `serverName`. `scope` is optional and passed
 * through to the client metadata.
 */
export class LocalStorageOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;

  /** The OAuth `state` of the most recent `state()` / `redirectToAuthorization` call. Set by `state()`
   *  (the value the SDK puts in the authorize URL) and re-confirmed from the URL inside
   *  `redirectToAuthorization`. The demo reads this after `createMcpTools` returns `'pending'` to
   *  correlate the redirect-back to this server's handle. */
  private pendingState?: string;
  /** Set when `window.open` was blocked; the demo shows this URL as a manual "Authorize" link. */
  private blockedAuthUrl?: URL;

  constructor(
    private readonly serverName: string,
    scope?: string,
  ) {
    this.redirectUrl = `${location.origin}${OAUTH_CALLBACK_PATH}`;
    const metadata: OAuthClientMetadata = {
      redirect_uris: [this.redirectUrl],
      client_name: `Forgewisp MCP demo (${serverName})`,
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    };
    if (scope) metadata.scope = scope;
    this.clientMetadata = metadata;
  }

  getPendingState(): string | undefined {
    return this.pendingState;
  }
  getBlockedAuthUrl(): URL | undefined {
    return this.blockedAuthUrl;
  }

  /**
   * The OAuth `state` parameter. The SDK calls this once per new authorization flow and includes the
   * returned value in the authorize URL. Without it the server redirects back with no `state`, which
   * breaks both the callback page (it requires `code` *and* `state`) and our handle correlation. We
   * generate a fresh opaque random value per flow, cache it on the instance (so `getPendingState()`
   * agrees with the URL even before `redirectToAuthorization` runs), and persist it so a same-tab
   * resume could validate it.
   */
  state(): string {
    const value =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.pendingState = value;
    const s = readState(this.serverName);
    writeState(this.serverName, { ...s, state: value });
    return value;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readState(this.serverName).clientInfo;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    const s = readState(this.serverName);
    writeState(this.serverName, { ...s, clientInfo: info });
  }

  tokens(): OAuthTokens | undefined {
    return readState(this.serverName).tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    const s = readState(this.serverName);
    writeState(this.serverName, { ...s, tokens });
  }

  saveCodeVerifier(codeVerifier: string): void {
    const s = readState(this.serverName);
    writeState(this.serverName, { ...s, verifier: codeVerifier });
  }
  codeVerifier(): string {
    const stored = readState(this.serverName).verifier;
    if (stored) return stored;
    // No verifier persisted (saveCodeVerifier never ran, or localStorage was cleared/quota-hit
    // between the redirect and the resume). Generate AND persist a fresh random one so the exchange
    // uses an unpredictable verifier rather than a known constant — a strict server returns
    // invalid_grant on the challenge mismatch either way, but a constant would let anyone who
    // captured the authorize URL complete the exchange themselves against a server that doesn't
    // strictly validate the challenge. Persisting keeps it stable across the read(s) the exchange
    // makes. The real verifier is normally saved by `saveCodeVerifier` before the redirect.
    const v = randomVerifier();
    const s = readState(this.serverName);
    writeState(this.serverName, { ...s, verifier: v });
    return v;
  }

  redirectToAuthorization(url: URL): void {
    // The SDK built `url` with the `state` it generated — capture it so the demo can correlate the
    // redirect-back to this server's pending handle.
    this.pendingState = url.searchParams.get('state') ?? undefined;
    const popup = window.open(url, 'forgewisp-mcp-oauth', 'popup,width=640,height=720');
    if (!popup) {
      // Popup blocked — record the URL for a manual "Authorize" link (same-tab fallback). The demo
      // also persists the pending server config so the load-resume path can complete after return.
      this.blockedAuthUrl = url;
    } else {
      this.blockedAuthUrl = undefined;
    }
  }

  invalidateCredentials(): void {
    // The server told us the tokens are dead (e.g. revoked / refresh failed). Drop them so the next
    // connect re-runs the authorization flow. Keep client info (still registered with the server).
    const s = readState(this.serverName);
    writeState(this.serverName, { ...s, tokens: undefined });
  }

  /** Drop ALL persisted state for this server (used on explicit disconnect). */
  static clear(serverName: string): void {
    localStorage.removeItem(storageKey(serverName));
  }
}
